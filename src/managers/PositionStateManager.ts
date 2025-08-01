import * as hl from '@nktkas/hyperliquid';
import logger from '../logger';

/**
 * 持仓状态管理器
 * 负责获取、缓存和追踪用户的持仓状态
 */
export class PositionStateManager {
    private infoClient: hl.InfoClient;
    private positionCache = new Map<string, CachedPosition>();
    private readonly CACHE_DURATION = 5 * 60 * 1000; // 5分钟缓存
    private readonly API_RATE_LIMIT_MS = 2000; // 2秒API限制
    private lastApiCall = 0;
    
    // 统计信息
    private stats = {
        cacheHits: 0,
        cacheMisses: 0,
        apiCalls: 0,
        errors: 0
    };

    constructor(infoClient: hl.InfoClient) {
        this.infoClient = infoClient;
        
        // 定期清理过期缓存
        setInterval(() => this.cleanExpiredCache(), 10 * 60 * 1000); // 10分钟清理一次
        
        logger.info('📊 持仓状态管理器初始化完成', {
            cacheDuration: `${this.CACHE_DURATION / 1000}s`,
            rateLimit: `${this.API_RATE_LIMIT_MS / 1000}s`
        });
    }

    /**
     * 获取用户持仓状态
     */
    async getUserPosition(userAddress: string): Promise<UserPositionState | null> {
        const cacheKey = userAddress.toLowerCase();
        
        // 检查缓存
        const cached = this.positionCache.get(cacheKey);
        if (cached && !this.isCacheExpired(cached)) {
            this.stats.cacheHits++;
            logger.debug(`📋 使用缓存持仓数据`, {
                user: this.formatAddress(userAddress),
                cacheAge: Math.round((Date.now() - cached.timestamp) / 1000) + 's'
            });
            return cached.data;
        }

        this.stats.cacheMisses++;
        
        try {
            // 速率限制检查
            await this.enforceRateLimit();
            
            // 获取最新持仓数据
            const positionData = await this.fetchUserPositionFromAPI(userAddress);
            
            // 更新缓存
            this.positionCache.set(cacheKey, {
                data: positionData,
                timestamp: Date.now()
            });
            
            logger.debug(`🔄 更新用户持仓缓存`, {
                user: this.formatAddress(userAddress),
                positionsCount: positionData.positions.length,
                totalValue: positionData.totalNotionalValue
            });
            
            return positionData;
            
        } catch (error) {
            this.stats.errors++;
            logger.error(`❌ 获取用户持仓失败`, {
                user: this.formatAddress(userAddress),
                error: error instanceof Error ? error.message : error
            });
            
            // 如果API失败，返回过期的缓存数据（如果有的话）
            if (cached) {
                logger.warn(`⚠️ API失败，使用过期缓存数据`, {
                    user: this.formatAddress(userAddress),
                    cacheAge: Math.round((Date.now() - cached.timestamp) / 1000) + 's'
                });
                return cached.data;
            }
            
            return null;
        }
    }

    /**
     * 获取特定资产的持仓信息
     */
    async getAssetPosition(userAddress: string, asset: string): Promise<AssetPosition | null> {
        const userPosition = await this.getUserPosition(userAddress);
        if (!userPosition) return null;
        
        const assetPosition = userPosition.positions.find(pos => pos.asset === asset);
        return assetPosition || null;
    }

    /**
     * 比较持仓变化
     */
    async comparePositionChange(
        userAddress: string, 
        asset: string,
        beforePosition?: AssetPosition | null
    ): Promise<PositionChangeAnalysis> {
        const currentPosition = await this.getAssetPosition(userAddress, asset);
        const before = beforePosition || { asset, size: 0, side: 'none', entryPrice: 0, unrealizedPnl: 0 };
        const current = currentPosition || { asset, size: 0, side: 'none', entryPrice: 0, unrealizedPnl: 0 };
        
        const sizeChange = current.size - before.size;
        const sideChanged = before.side !== current.side;
        
        let changeType: PositionChangeType;
        let description: string;
        
        if (before.size === 0 && current.size > 0) {
            changeType = current.side === 'long' ? 'OPEN_LONG' : 'OPEN_SHORT';
            description = `新开${current.side === 'long' ? '多' : '空'}仓`;
        } else if (before.size > 0 && current.size === 0) {
            changeType = 'CLOSE_POSITION';
            description = `平仓`;
        } else if (sideChanged) {
            changeType = 'REVERSE_POSITION';
            description = `反向开仓 (${before.side} → ${current.side})`;
        } else if (Math.abs(sizeChange) > 0) {
            if (sizeChange > 0) {
                changeType = 'INCREASE_POSITION';
                description = `加仓 (+${sizeChange})`;
            } else {
                changeType = 'DECREASE_POSITION';
                description = `减仓 (${sizeChange})`;
            }
        } else {
            changeType = 'NO_CHANGE';
            description = '无变化';
        }
        
        return {
            changeType,
            description,
            beforePosition: before,
            currentPosition: current,
            sizeChange,
            sideChanged
        };
    }

    /**
     * 强制刷新用户持仓缓存
     */
    async refreshUserPosition(userAddress: string): Promise<UserPositionState | null> {
        const cacheKey = userAddress.toLowerCase();
        this.positionCache.delete(cacheKey);
        return await this.getUserPosition(userAddress);
    }

    /**
     * 从API获取用户持仓数据
     */
    private async fetchUserPositionFromAPI(userAddress: string): Promise<UserPositionState> {
        this.stats.apiCalls++;
        this.lastApiCall = Date.now();
        
        logger.debug(`🔍 调用API获取持仓数据`, {
            user: this.formatAddress(userAddress)
        });
        
        const clearinghouseState = await this.infoClient.clearinghouseState({
            user: userAddress as `0x${string}`
        });
        
        // 解析持仓数据
        const positions: AssetPosition[] = [];
        let totalNotionalValue = 0;
        
        if (clearinghouseState.assetPositions) {
            for (const assetPos of clearinghouseState.assetPositions) {
                if (assetPos.position && assetPos.position.szi !== "0") {
                    const size = Math.abs(parseFloat(assetPos.position.szi));
                    const side = parseFloat(assetPos.position.szi) > 0 ? 'long' : 'short';
                    const entryPrice = parseFloat(assetPos.position.entryPx || '0');
                    const unrealizedPnl = parseFloat(assetPos.position.unrealizedPnl || '0');
                    const notionalValue = size * entryPrice;
                    
                    positions.push({
                        asset: assetPos.position.coin,
                        size,
                        side,
                        entryPrice,
                        unrealizedPnl,
                        notionalValue
                    });
                    
                    totalNotionalValue += notionalValue;
                }
            }
        }
        
        return {
            userAddress: userAddress.toLowerCase(),
            positions,
            totalNotionalValue,
            accountValue: parseFloat(clearinghouseState.marginSummary.accountValue || '0'),
            totalMarginUsed: parseFloat(clearinghouseState.marginSummary.totalMarginUsed || '0'),
            timestamp: Date.now()
        };
    }

    /**
     * 速率限制检查
     */
    private async enforceRateLimit(): Promise<void> {
        const timeSinceLastCall = Date.now() - this.lastApiCall;
        if (timeSinceLastCall < this.API_RATE_LIMIT_MS) {
            const waitTime = this.API_RATE_LIMIT_MS - timeSinceLastCall;
            logger.debug(`⏰ 速率限制等待 ${waitTime}ms`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
    }

    /**
     * 检查缓存是否过期
     */
    private isCacheExpired(cached: CachedPosition): boolean {
        return Date.now() - cached.timestamp > this.CACHE_DURATION;
    }

    /**
     * 清理过期缓存
     */
    private cleanExpiredCache(): void {
        let cleanedCount = 0;
        for (const [key, cached] of this.positionCache.entries()) {
            if (this.isCacheExpired(cached)) {
                this.positionCache.delete(key);
                cleanedCount++;
            }
        }
        
        if (cleanedCount > 0) {
            logger.debug(`🧹 清理过期缓存`, {
                cleaned: cleanedCount,
                remaining: this.positionCache.size
            });
        }
    }

    /**
     * 格式化地址显示
     */
    private formatAddress(address: string): string {
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    }

    /**
     * 获取统计信息
     */
    getStats() {
        const cacheSize = this.positionCache.size;
        const hitRate = this.stats.cacheHits + this.stats.cacheMisses > 0 
            ? Math.round((this.stats.cacheHits / (this.stats.cacheHits + this.stats.cacheMisses)) * 100)
            : 0;
            
        return {
            ...this.stats,
            cacheSize,
            hitRate: `${hitRate}%`,
            lastApiCall: this.lastApiCall
        };
    }

    /**
     * 重置统计信息
     */
    resetStats(): void {
        this.stats = {
            cacheHits: 0,
            cacheMisses: 0,
            apiCalls: 0,
            errors: 0
        };
    }
}

// 类型定义
interface CachedPosition {
    data: UserPositionState;
    timestamp: number;
}

export interface UserPositionState {
    userAddress: string;
    positions: AssetPosition[];
    totalNotionalValue: number;
    accountValue: number;
    totalMarginUsed: number;
    timestamp: number;
}

export interface AssetPosition {
    asset: string;
    size: number;
    side: 'long' | 'short' | 'none';
    entryPrice: number;
    unrealizedPnl: number;
    notionalValue?: number;
}

export interface PositionChangeAnalysis {
    changeType: PositionChangeType;
    description: string;
    beforePosition: AssetPosition;
    currentPosition: AssetPosition;
    sizeChange: number;
    sideChanged: boolean;
}

export type PositionChangeType = 
    | 'OPEN_LONG' 
    | 'OPEN_SHORT' 
    | 'CLOSE_POSITION' 
    | 'INCREASE_POSITION' 
    | 'DECREASE_POSITION' 
    | 'REVERSE_POSITION' 
    | 'NO_CHANGE';

export default PositionStateManager;