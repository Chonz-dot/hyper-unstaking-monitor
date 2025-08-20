import { ContractEvent, ContractTrader } from '../types';
import { PositionStateManager, PositionChangeAnalysis, PositionChangeType, AssetPosition } from './PositionStateManager';
import logger from '../logger';

/**
 * 合约交易事件（已分析）
 */
export interface AnalyzedContractEvent extends ContractEvent {
    // 分析分类信息
    classification?: {
        type: string;
        description: string;
        confidence: 'high' | 'medium' | 'low';
    };

    // 持仓变化信息
    positionChange?: {
        sizeChange: number;
        sideChanged: boolean;
    };

    // 持仓快照
    positionBefore?: any;
    positionAfter?: any;

    // 元数据 - 修复类型兼容性
    metadata?: {
        notionalValue?: string;
        leverage?: string;  // 改为string类型以兼容ContractEvent
        originalFill?: any;
        [key: string]: any;
    };

    // 盈亏信息（如果是平仓）
    realizedPnL?: number;
}
/**
 * 交易分类引擎
 * 基于持仓状态准确识别交易类型
 */
export class TradeClassificationEngine {
    private positionManager: PositionStateManager;

    // 统计信息
    private stats = {
        totalClassifications: 0,
        classificationTypes: new Map<PositionChangeType, number>(),
        errors: 0
    };

    constructor(positionManager: PositionStateManager) {
        this.positionManager = positionManager;

        logger.info('🔍 交易分类引擎初始化完成');
    }

    /**
     * 分类交易事件，返回准确的交易类型
     */
    async classifyTrade(
        fill: any,
        trader: ContractTrader,
        delayMs: number = 8000,  // 🔧 增加到8秒
        maxRetries: number = 2
    ): Promise<AnalyzedContractEvent | null> {
        try {
            const asset = fill.coin;
            
            logger.info(`🔍 [调试] 开始交易分类`, {
                trader: trader.label,
                asset,
                fillSide: fill.side,
                fillSize: fill.sz,
                delayMs
            });
            
            // 🔧 获取交易前的持仓状态
            const beforePosition = await this.getAssetPosition(trader.address, asset);
            
            logger.info(`🔍 [调试] 等待${delayMs}ms让交易结算...`);
            // 等待一段时间让交易结算
            await new Promise(resolve => setTimeout(resolve, delayMs));
            
            // 🔧 获取交易后的持仓状态（清除缓存强制刷新）
            this.clearUserPositionCache(trader.address);
            const afterPosition = await this.getAssetPosition(trader.address, asset);
            
            logger.info(`🔍 [调试] 持仓状态对比完成`, {
                trader: trader.label,
                asset,
                beforePosition: beforePosition ? {
                    size: beforePosition.size,
                    side: beforePosition.side,
                    entryPrice: beforePosition.entryPrice
                } : null,
                afterPosition: afterPosition ? {
                    size: afterPosition.size,
                    side: afterPosition.side,
                    entryPrice: afterPosition.entryPrice
                } : null,
                hasValidComparison: beforePosition !== null || afterPosition !== null
            });
            
            // 使用真实的持仓状态进行分类
            const featureClassification = this.classifyByTradeCharacteristics(fill, beforePosition, afterPosition);
            
            return this.createAnalyzedEventFromFeatures(
                fill,
                trader,
                featureClassification,
                beforePosition,
                afterPosition
            );
            
        } catch (error) {
            logger.error(`🔍 [调试] 交易分类失败:`, error);
            // 降级到简单分类
            const fallbackClassification = this.getFallbackClassification(fill);
            return this.createAnalyzedEventFromFeatures(
                fill,
                trader,
                fallbackClassification,
                null,
                null
            );
        }
    }

    /**
     * 获取特定资产的持仓信息
     */
    private async getAssetPosition(userAddress: string, asset: string): Promise<AssetPosition | null> {
        try {
            logger.info(`🔍 [调试] 开始获取持仓信息`, {
                userAddress: userAddress.slice(0, 6) + '...' + userAddress.slice(-4),
                asset
            });

            const userPosition = await this.positionManager.getUserPosition(userAddress);
            
            logger.info(`🔍 [调试] 持仓管理器返回结果`, {
                userAddress: userAddress.slice(0, 6) + '...' + userAddress.slice(-4),
                hasUserPosition: !!userPosition,
                hasPositions: !!(userPosition?.positions),
                positionsCount: userPosition?.positions?.length || 0,
                allAssets: userPosition?.positions?.map(p => p.asset) || []
            });

            if (!userPosition || !userPosition.positions) {
                logger.warn(`🔍 [调试] 用户持仓数据为空`, {
                    userAddress: userAddress.slice(0, 6) + '...' + userAddress.slice(-4),
                    asset,
                    userPosition: !!userPosition,
                    positions: !!userPosition?.positions
                });
                return null;
            }

            // 查找特定资产的持仓
            const assetPosition = userPosition.positions.find(pos => pos.asset === asset);
            
            logger.info(`🔍 [调试] 资产持仓查找结果`, {
                userAddress: userAddress.slice(0, 6) + '...' + userAddress.slice(-4),
                asset,
                found: !!assetPosition,
                assetPosition: assetPosition ? {
                    asset: assetPosition.asset,
                    size: assetPosition.size,
                    side: assetPosition.side,
                    entryPrice: assetPosition.entryPrice
                } : null
            });

            if (!assetPosition) {
                return null;
            }

            // assetPosition 已经是 AssetPosition 类型，直接返回
            return assetPosition;

        } catch (error) {
            logger.error(`🔍 [调试] 获取${asset}持仓失败:`, error);
            return null;
        }
    }

    /**
     * 清除特定用户的持仓缓存 - 改进版
     */
    private clearUserPositionCache(userAddress: string): void {
        try {
            // 通过反射访问私有属性（临时解决方案）
            const positionManager = this.positionManager as any;
            if (positionManager.positionCache) {
                const cacheKey = userAddress.toLowerCase();
                const hadCache = positionManager.positionCache.has(cacheKey);
                positionManager.positionCache.delete(cacheKey);
                
                logger.info(`🔍 [调试] 持仓缓存清除`, {
                    userAddress: userAddress.slice(0, 6) + '...' + userAddress.slice(-4),
                    hadCache,
                    remainingCacheSize: positionManager.positionCache.size
                });
            } else {
                logger.warn(`🔍 [调试] 无法访问持仓缓存`);
            }
        } catch (error) {
            logger.error(`🔍 [调试] 清除缓存失败:`, error);
        }
    }

    /**
     * 验证持仓变化是否合理
     */
    private isPositionChangeValid(
        beforePosition: AssetPosition | null,
        afterPosition: AssetPosition | null,
        fill: any
    ): boolean {
        // 如果没有前后持仓数据，无法验证
        if (!beforePosition && !afterPosition) {
            logger.warn(`⚠️ 无法验证持仓变化：缺少持仓数据`);
            return false;
        }

        const fillSize = Math.abs(parseFloat(fill.sz || '0'));
        const beforeSize = Math.abs(beforePosition?.size || 0);
        const afterSize = Math.abs(afterPosition?.size || 0);
        const sizeChange = Math.abs(afterSize - beforeSize);

        // 持仓变化应该接近交易数量（允许5%的误差）
        const tolerance = fillSize * 0.05;
        const isValidChange = Math.abs(sizeChange - fillSize) <= tolerance;

        logger.info(`🔍 [调试] 持仓变化验证`, {
            fillSize,
            beforeSize,
            afterSize,
            sizeChange,
            tolerance,
            isValidChange,
            changeRatio: sizeChange / fillSize
        });

        return isValidChange;
    }

    /**
     * 降级分类方法
     */
    private getFallbackClassification(fill: any): { eventType: ContractEvent['eventType'], description: string, confidence: 'high' | 'medium' | 'low' } {
        const fillSide = fill.side === 'B' ? 'long' : 'short';
        return {
            eventType: fillSide === 'long' ? 'position_open_long' : 'position_open_short',
            description: `${fillSide === 'long' ? '开多仓' : '开空仓'} (简化分类)`,
            confidence: 'low'
        };
    }

    /**
     * 基于交易特征的智能分类 - 修复持仓无变化问题
     */
    private classifyByTradeCharacteristics(
        fill: any,
        beforePosition: AssetPosition | null,
        afterPosition: AssetPosition | null
    ): { eventType: ContractEvent['eventType'], description: string, confidence: 'high' | 'medium' | 'low' } {
        const fillSide = fill.side === 'B' ? 'long' : 'short';
        
        // 🔧 基于前后持仓状态进行准确分类
        const beforeSize = beforePosition?.size || 0;
        const afterSize = afterPosition?.size || 0;
        const beforeSide = beforePosition?.side;
        const afterSide = afterPosition?.side;
        const fillSize = Math.abs(parseFloat(fill.sz || '0'));
        
        logger.info(`🔍 [调试] 交易分类分析`, {
            fillSide,
            fillSize: fill.sz,
            before: { size: beforeSize, side: beforeSide },
            after: { size: afterSize, side: afterSide }
        });
        
        // 🔧 新增：如果持仓无变化，使用交易数据推断操作类型
        if (Math.abs(beforeSize) === Math.abs(afterSize) && beforeSide === afterSide) {
            logger.warn(`⚠️ 持仓数据无变化，基于交易数据推断操作类型`, {
                fillSize,
                fillSide,
                beforeSize,
                afterSize,
                推断逻辑: '根据现有持仓和交易方向判断'
            });
            
            // 如果已有持仓且方向相同 -> 加仓
            if (Math.abs(beforeSize) > 0 && beforeSide === fillSide) {
                return {
                    eventType: 'position_increase',
                    description: `${fillSide === 'long' ? '多仓' : '空仓'}加仓 (推断)`,
                    confidence: 'medium'
                };
            }
            
            // 如果已有持仓且方向相反 -> 减仓或平仓
            if (Math.abs(beforeSize) > 0 && beforeSide !== fillSide) {
                // 判断是减仓还是平仓
                if (fillSize >= Math.abs(beforeSize)) {
                    return {
                        eventType: 'position_close',
                        description: '平仓 (推断)',
                        confidence: 'medium'
                    };
                } else {
                    return {
                        eventType: 'position_decrease',
                        description: `${beforeSide === 'long' ? '多仓' : '空仓'}减仓 (推断)`,
                        confidence: 'medium'
                    };
                }
            }
            
            // 如果没有持仓 -> 开仓
            if (Math.abs(beforeSize) === 0) {
                return {
                    eventType: fillSide === 'long' ? 'position_open_long' : 'position_open_short',
                    description: `${fillSide === 'long' ? '开多仓' : '开空仓'} (推断)`,
                    confidence: 'medium'
                };
            }
        }
        
        // 原有的精确分类逻辑
        // 情况1: 之前没有持仓，现在有持仓 -> 开仓
        if (Math.abs(beforeSize) === 0 && Math.abs(afterSize) > 0) {
            return {
                eventType: fillSide === 'long' ? 'position_open_long' : 'position_open_short',
                description: `${fillSide === 'long' ? '开多仓' : '开空仓'}`,
                confidence: 'high'
            };
        }
        
        // 情况2: 之前有持仓，现在没有持仓 -> 平仓
        if (Math.abs(beforeSize) > 0 && Math.abs(afterSize) === 0) {
            return {
                eventType: 'position_close',
                description: '平仓',
                confidence: 'high'
            };
        }
        
        // 情况3: 之前有持仓，现在持仓增加 -> 加仓
        if (Math.abs(beforeSize) > 0 && Math.abs(afterSize) > Math.abs(beforeSize)) {
            const currentSide = afterSide || fillSide;
            return {
                eventType: 'position_increase',
                description: `${currentSide === 'long' ? '多仓' : '空仓'}加仓`,
                confidence: 'high'
            };
        }
        
        // 情况4: 之前有持仓，现在持仓减少但未完全平仓 -> 减仓
        if (Math.abs(beforeSize) > 0 && Math.abs(afterSize) < Math.abs(beforeSize) && Math.abs(afterSize) > 0) {
            const currentSide = afterSide || beforeSide;
            return {
                eventType: 'position_decrease',
                description: `${currentSide === 'long' ? '多仓' : '空仓'}减仓`,
                confidence: 'high'
            };
        }
        
        // 情况5: 方向改变 -> 反手
        if (beforeSide && afterSide && beforeSide !== afterSide) {
            return {
                eventType: 'position_reverse',
                description: `${beforeSide === 'long' ? '多转空' : '空转多'}`,
                confidence: 'high'
            };
        }
        
        // 默认情况：使用填充的方向作为开仓
        logger.error(`❌ 无法明确分类交易，使用默认逻辑`, {
            beforeSize, 
            afterSize, 
            beforeSide, 
            afterSide, 
            fillSide,
            fillSize: fill.sz,
            trader: fill.user || 'unknown',
            问题诊断: {
                是否有前置持仓: beforePosition !== null,
                是否有后置持仓: afterPosition !== null,
                前置持仓大小: beforeSize,
                后置持仓大小: afterSize,
                持仓大小差异: Math.abs(afterSize - beforeSize),
                可能的问题: [
                    beforePosition === null && afterPosition === null ? '无法获取持仓数据' : null,
                    beforeSize === afterSize ? '持仓无变化' : null,
                    '可能需要增加延迟时间'
                ].filter(Boolean)
            }
        });
        
        return {
            eventType: fillSide === 'long' ? 'position_open_long' : 'position_open_short',
            description: `${fillSide === 'long' ? '开多仓' : '开空仓'} (默认)`,
            confidence: 'low'
        };
    }

    /**
     * 基于特征分析创建分析事件 - 改进盈亏计算
     */
    private createAnalyzedEventFromFeatures(
        fill: any,
        trader: ContractTrader,
        classification: { eventType: ContractEvent['eventType'], description: string, confidence: 'high' | 'medium' | 'low' },
        beforePosition: AssetPosition | null,
        afterPosition: AssetPosition | null
    ): AnalyzedContractEvent {
        const fillSize = Math.abs(parseFloat(fill.sz || '0'));
        const price = parseFloat(fill.px || '0');
        const fillSide = fill.side === 'B' ? 'long' : 'short';

        let blockTime: number;
        if (fill.time) {
            blockTime = fill.time > 1e12 ? Math.floor(fill.time / 1000) : Math.floor(fill.time);
        } else {
            blockTime = Math.floor(Date.now() / 1000);
        }

        // 🔧 计算持仓变化
        const beforeSize = beforePosition?.size || 0;
        const afterSize = afterPosition?.size || 0;
        const sizeChange = afterSize - beforeSize;
        const sideChanged = (beforePosition?.side !== afterPosition?.side) && 
                           beforePosition?.side && afterPosition?.side;

        // 🔧 计算已实现盈亏（仅限平仓或减仓）
        let realizedPnL: number | undefined;
        if (classification.eventType === 'position_close' || classification.eventType === 'position_decrease') {
            realizedPnL = this.calculateRealizedPnL(beforePosition, afterPosition, price);
        }

        // 🔧 修复：根据交易类型确定正确的方向
        let correctSide: 'long' | 'short';
        switch (classification.eventType) {
            case 'position_open_long':
            case 'position_open_short':
                // 开仓：使用交易方向
                correctSide = fillSide;
                break;
            case 'position_close':
            case 'position_decrease':
                // 平仓/减仓：使用原持仓方向，排除 'none'
                correctSide = (beforePosition?.side && beforePosition.side !== 'none') 
                    ? beforePosition.side as 'long' | 'short'
                    : fillSide;
                break;
            case 'position_increase':
                // 加仓：使用当前持仓方向，排除 'none'
                correctSide = (afterPosition?.side && afterPosition.side !== 'none')
                    ? afterPosition.side as 'long' | 'short'
                    : fillSide;
                break;
            case 'position_reverse':
                // 反手：使用新的持仓方向，排除 'none'
                correctSide = (afterPosition?.side && afterPosition.side !== 'none')
                    ? afterPosition.side as 'long' | 'short'
                    : fillSide;
                break;
            default:
                // 默认使用交易方向
                correctSide = fillSide;
        }

        logger.info(`🔍 [调试] 方向判断修复`, {
            eventType: classification.eventType,
            fillSide,
            beforeSide: beforePosition?.side,
            afterSide: afterPosition?.side,
            correctSide,
            description: classification.description
        });

        const event: AnalyzedContractEvent = {
            timestamp: Date.now(),
            address: trader.address,
            eventType: classification.eventType,
            asset: fill.coin,
            size: fillSize.toString(),
            price: price.toString(),
            side: correctSide, // 🔧 使用修复后的正确方向
            hash: fill.hash || fill.tid || `analyzed_${Date.now()}_${fill.coin}`,
            blockTime,

            // 分析字段
            classification: {
                type: classification.eventType,
                description: classification.description,
                confidence: classification.confidence
            },
            positionBefore: beforePosition,
            positionAfter: afterPosition,
            positionChange: {
                sizeChange,
                sideChanged: !!sideChanged
            },

            // 🔧 添加盈亏信息
            realizedPnL,

            metadata: {
                notionalValue: (fillSize * price).toString(),
                leverage: "1",
                originalFill: fill,
                // 添加调试信息
                classificationDebug: {
                    beforeSize,
                    afterSize,
                    sizeChange,
                    hasRealizedPnL: realizedPnL !== undefined
                }
            }
        };

        logger.info(`✅ 交易分类完成`, {
            trader: trader.label,
            asset: fill.coin,
            eventType: classification.eventType,
            description: classification.description,
            confidence: classification.confidence,
            sizeChange,
            realizedPnL: realizedPnL?.toFixed(2) || 'N/A'
        });

        return event;
    }

    /**
     * 计算已实现盈亏
     */
    private calculateRealizedPnL(
        beforePosition: AssetPosition | null,
        afterPosition: AssetPosition | null,
        exitPrice: number
    ): number | undefined {
        if (!beforePosition || beforePosition.size === 0) {
            return undefined;
        }

        const entryPrice = beforePosition.entryPrice || 0;
        if (entryPrice === 0) {
            return undefined;
        }

        // 计算平仓的数量
        const beforeSize = Math.abs(beforePosition.size);
        const afterSize = Math.abs(afterPosition?.size || 0);
        const closedSize = beforeSize - afterSize;

        if (closedSize <= 0) {
            return undefined;
        }

        // 计算盈亏
        const side = beforePosition.side;
        let pnl: number;

        if (side === 'long') {
            // 多头盈亏：(卖出价 - 买入价) * 数量
            pnl = (exitPrice - entryPrice) * closedSize;
        } else {
            // 空头盈亏：(买入价 - 卖出价) * 数量
            pnl = (entryPrice - exitPrice) * closedSize;
        }

        logger.info(`💰 计算已实现盈亏`, {
            side,
            entryPrice,
            exitPrice,
            closedSize,
            realizedPnL: pnl.toFixed(2)
        });

        return pnl;
    }

    /**
     * 获取统计信息
     */
    getStats() {
        return {
            totalClassifications: this.stats.totalClassifications,
            errors: this.stats.errors,
            classificationTypes: Object.fromEntries(this.stats.classificationTypes)
        };
    }
}

// 验证结果接口
interface ValidationResult {
    isValid: boolean;
    reason?: string;
}
