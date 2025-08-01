import { EventEmitter } from 'events';
import { WatchedAddress, MonitorEvent } from '../types';
import logger from '../logger';
import * as hl from '@nktkas/hyperliquid';

/**
 * RPC现货监听器
 * 使用HTTP轮询代替WebSocket，提供更稳定的现货转账监听
 */
export class RpcSpotMonitor extends EventEmitter {
    private addresses: WatchedAddress[];
    private infoClient: hl.InfoClient;
    private isRunning = false;
    private pollingIntervals: NodeJS.Timeout[] = [];
    
    // 轮询配置
    private readonly POLLING_INTERVAL = 30000; // 30秒轮询间隔
    private readonly ERROR_RETRY_DELAY = 60000; // 错误重试延迟60秒
    
    // 追踪已处理的转账，避免重复
    private lastProcessedTime = new Map<string, number>();
    private processedTransfers = new Set<string>(); // 使用hash避免重复
    private readonly MAX_CACHE_SIZE = 5000;
    
    // 统计信息
    private stats = {
        totalRequests: 0,
        totalErrors: 0,
        totalEvents: 0,
        lastSuccessfulPoll: 0,
        consecutiveErrors: 0,
        transfersProcessed: 0,
        addressesMonitored: 0
    };

    constructor(addresses: WatchedAddress[]) {
        super();
        this.addresses = addresses.filter(addr => addr.isActive);
        this.stats.addressesMonitored = this.addresses.length;
        
        // 初始化Info客户端
        const transport = new hl.HttpTransport({
            timeout: 30000,
            isTestnet: false
        });
        this.infoClient = new hl.InfoClient({ transport });
        
        logger.info('🔧 RPC现货监听器初始化完成', {
            activeAddresses: this.addresses.length,
            pollingInterval: `${this.POLLING_INTERVAL / 1000}s`,
            strategy: 'HTTP轮询 + 账本更新查询'
        });
    }

    async start(): Promise<void> {
        if (this.isRunning) {
            logger.warn('RPC现货监听器已在运行');
            return;
        }

        logger.info('🚀 启动RPC现货监听器');
        this.isRunning = true;
        this.stats.lastSuccessfulPoll = Date.now();

        try {
            // 测试API连接
            logger.info('🔧 测试Hyperliquid API连接...');
            const testMeta = await this.infoClient.meta();
            
            if (testMeta) {
                logger.info('✅ API连接成功', {
                    universeLength: testMeta.universe?.length || 0
                });
            }

            // 为每个地址启动独立的轮询
            for (const address of this.addresses) {
                this.startAddressPolling(address);
            }

            logger.info('✅ RPC现货监听器启动成功', {
                monitoredAddresses: this.addresses.length,
                strategy: 'rpc-polling',
                pollingInterval: `${this.POLLING_INTERVAL / 1000}s`
            });

        } catch (error) {
            logger.error('❌ RPC现货监听器启动失败:', error);
            this.isRunning = false;
            throw error;
        }
    }

    async stop(): Promise<void> {
        if (!this.isRunning) {
            logger.warn('RPC现货监听器未在运行');
            return;
        }

        logger.info('🛑 停止RPC现货监听器');
        this.isRunning = false;

        // 清理所有轮询间隔
        for (const interval of this.pollingIntervals) {
            clearInterval(interval);
        }
        this.pollingIntervals = [];

        logger.info('✅ RPC现货监听器已停止');
    }

    /**
     * 为单个地址启动轮询
     */
    private startAddressPolling(address: WatchedAddress): void {
        const pollAddress = async () => {
            if (!this.isRunning) return;

            try {
                await this.pollAddressTransfers(address);
                this.stats.consecutiveErrors = 0;
            } catch (error) {
                this.stats.totalErrors++;
                this.stats.consecutiveErrors++;
                
                logger.error(`❌ ${address.label}轮询失败:`, error);
                
                // 如果连续错误太多，增加延迟
                if (this.stats.consecutiveErrors > 5) {
                    logger.warn(`${address.label}连续错误过多，暂停轮询60秒`);
                    setTimeout(() => {
                        if (this.isRunning) {
                            this.startAddressPolling(address);
                        }
                    }, 60000);
                    return;
                }
            }

            // 继续轮询
            if (this.isRunning) {
                setTimeout(pollAddress, this.POLLING_INTERVAL);
            }
        };

        // 立即开始第一次轮询
        setTimeout(pollAddress, Math.random() * 5000); // 随机延迟0-5秒，避免所有地址同时查询
    }

    /**
     * 轮询单个地址的转账记录
     */
    private async pollAddressTransfers(address: WatchedAddress): Promise<void> {
        this.stats.totalRequests++;
        
        const endTime = Date.now();
        const startTime = this.lastProcessedTime.get(address.address) || (endTime - 3600000); // 默认查询1小时内
        
        try {
            // 查询账本更新（包含转账记录）
            const ledgerUpdates = await this.infoClient.userNonFundingLedgerUpdates({
                user: address.address as `0x${string}`,
                startTime,
                endTime
            });

            if (ledgerUpdates && ledgerUpdates.length > 0) {
                logger.debug(`📊 ${address.label}获取到${ledgerUpdates.length}个账本更新`, {
                    timeRange: `${new Date(startTime).toISOString()} - ${new Date(endTime).toISOString()}`
                });

                // 处理每个账本更新
                for (const update of ledgerUpdates) {
                    await this.processLedgerUpdate(update, address);
                }
            }

            // 更新最后处理时间
            this.lastProcessedTime.set(address.address, endTime);
            this.stats.lastSuccessfulPoll = Date.now();

        } catch (error) {
            logger.error(`❌ 查询${address.label}账本更新失败:`, error);
            throw error;
        }
    }

    /**
     * 处理账本更新
     */
    private async processLedgerUpdate(update: any, address: WatchedAddress): Promise<void> {
        try {
            // 生成唯一标识，避免重复处理
            const updateHash = `${address.address}_${update.time}_${update.hash || update.delta?.USDC || update.delta?.coin}`;
            
            if (this.processedTransfers.has(updateHash)) {
                return; // 已处理过
            }

            // 检查是否是转账相关的更新
            if (!this.isTransferUpdate(update)) {
                return;
            }

            // 解析转账信息
            const transferEvent = this.parseTransferUpdate(update, address);
            
            if (transferEvent) {
                // 检查金额阈值
                const notionalValue = parseFloat(transferEvent.amount);
                if (notionalValue >= 100) { // 100 USDC阈值
                    this.processedTransfers.add(updateHash);
                    this.stats.totalEvents++;
                    this.stats.transfersProcessed++;
                    
                    logger.info(`💰 检测到现货转账`, {
                        address: address.label,
                        eventType: transferEvent.eventType,
                        amount: transferEvent.amount,
                        asset: transferEvent.asset
                    });

                    // 发出事件
                    this.emit('spotEvent', transferEvent);
                }
            }

            // 清理缓存
            this.cleanupCache();

        } catch (error) {
            logger.error(`❌ 处理账本更新失败:`, error, { update, address: address.label });
        }
    }

    /**
     * 判断是否是转账相关的更新
     */
    private isTransferUpdate(update: any): boolean {
        // 检查更新类型，过滤出转账相关的
        const transferTypes = ['deposit', 'withdraw', 'transfer', 'internalTransfer', 'spotGenesis'];
        
        if (update.delta && Object.keys(update.delta).length > 0) {
            return true; // 有余额变化
        }
        
        if (update.type && transferTypes.includes(update.type)) {
            return true;
        }
        
        return false;
    }

    /**
     * 解析转账更新为MonitorEvent
     */
    private parseTransferUpdate(update: any, address: WatchedAddress): MonitorEvent | null {
        try {
            let amount = '0';
            let asset = 'USDC';
            let eventType: MonitorEvent['eventType'] = 'transfer_in';

            // 解析余额变化
            if (update.delta) {
                if (update.delta.USDC) {
                    amount = Math.abs(parseFloat(update.delta.USDC)).toString();
                    asset = 'USDC';
                    eventType = parseFloat(update.delta.USDC) > 0 ? 'transfer_in' : 'transfer_out';
                } else if (update.delta.coin) {
                    // 其他代币
                    const coinDelta = Object.entries(update.delta.coin || {})[0];
                    if (coinDelta) {
                        asset = coinDelta[0] as string;
                        amount = Math.abs(parseFloat(coinDelta[1] as string)).toString();
                        eventType = parseFloat(coinDelta[1] as string) > 0 ? 'transfer_in' : 'transfer_out';
                    }
                }
            }

            // 解析时间
            const blockTime = update.time ? Math.floor(update.time / 1000) : Math.floor(Date.now() / 1000);

            return {
                timestamp: Date.now(),
                address: address.address,
                eventType,
                amount,
                hash: update.hash || `ledger_${update.time}_${address.address}`,
                blockTime,
                asset,
                metadata: {
                    originalAsset: asset,
                    source: 'rpc-ledger',
                    addressLabel: address.label,
                    unlockAmount: address.unlockAmount,
                    delta: update.delta
                }
            };

        } catch (error) {
            logger.error(`❌ 解析转账更新失败:`, error, { update });
            return null;
        }
    }

    /**
     * 清理缓存
     */
    private cleanupCache(): void {
        if (this.processedTransfers.size > this.MAX_CACHE_SIZE) {
            const entries = Array.from(this.processedTransfers);
            const toRemove = entries.slice(0, this.MAX_CACHE_SIZE * 0.2); // 移除20%
            toRemove.forEach(entry => this.processedTransfers.delete(entry));
            
            logger.debug(`🧹 清理转账缓存`, {
                removed: toRemove.length,
                remaining: this.processedTransfers.size
            });
        }
    }

    /**
     * 获取统计信息
     */
    getStats() {
        const uptime = this.stats.lastSuccessfulPoll ? Date.now() - this.stats.lastSuccessfulPoll : 0;
        const successRate = this.stats.totalRequests > 0 
            ? Math.round(((this.stats.totalRequests - this.stats.totalErrors) / this.stats.totalRequests) * 100)
            : 0;

        return {
            ...this.stats,
            isRunning: this.isRunning,
            uptime: Math.floor(uptime / 1000),
            successRate: `${successRate}%`,
            cacheSize: this.processedTransfers.size,
            addresses: this.addresses.map(addr => ({
                address: addr.address,
                label: addr.label,
                lastProcessed: this.lastProcessedTime.get(addr.address)
            }))
        };
    }
}

export default RpcSpotMonitor;