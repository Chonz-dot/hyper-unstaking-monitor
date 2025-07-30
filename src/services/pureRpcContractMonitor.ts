import { EventEmitter } from 'events';
import { ContractTrader, ContractEvent, ContractWebhookAlert } from '../types';
import logger from '../logger';
import * as hl from '@nktkas/hyperliquid';

/**
 * 纯净RPC合约监控器 
 * 只使用官方Hyperliquid API，无Alchemy依赖，专注稳定性
 */
export class PureRpcContractMonitor extends EventEmitter {
    private traders: ContractTrader[];
    private minNotionalValue: number;
    private isRunning = false;
    private startTime: number;
    private infoClient: hl.InfoClient;
    private pollingIntervals: NodeJS.Timeout[] = [];
    
    // 轮询配置
    private readonly POLLING_INTERVAL = 10000; // 10秒轮询间隔，更频繁
    private readonly ERROR_RETRY_DELAY = 30000; // 错误重试延迟30秒
    
    // 订单聚合管理
    private lastProcessedTime = new Map<string, number>();
    private pendingOrderFills = new Map<string, any>();
    private readonly ORDER_COMPLETION_DELAY = 3000; // 3秒订单完成延迟
    
    // 统计信息
    private stats = {
        totalRequests: 0,
        totalErrors: 0,
        totalEvents: 0,
        totalAggregatedOrders: 0,
        lastSuccessfulPoll: 0,
        consecutiveErrors: 0,
        tradesProcessed: 0
    };

    constructor(traders: ContractTrader[], minNotionalValue = 1) {
        super();
        this.traders = traders.filter(t => t.isActive);
        this.minNotionalValue = minNotionalValue; // 默认1美元阈值
        this.startTime = Date.now();
        
        // 只使用官方API
        const transport = new hl.HttpTransport({
            timeout: 15000, // 15秒超时，更短
            isTestnet: false
        });
        this.infoClient = new hl.InfoClient({ transport });
        
        // 初始化时间：从1小时前开始，更保守
        const oneHourAgo = Date.now() - 60 * 60 * 1000;
        this.traders.forEach(trader => {
            this.lastProcessedTime.set(trader.address, oneHourAgo);
        });

        logger.info('🔄 初始化纯净RPC合约监控器', {
            activeTraders: this.traders.length,
            minNotionalValue,
            strategy: '纯官方API + 快速轮询',
            pollingInterval: `${this.POLLING_INTERVAL / 1000}s`,
            orderCompletionDelay: `${this.ORDER_COMPLETION_DELAY / 1000}s`,
            initialTimeRange: '1小时前开始'
        });
    }

    async start(): Promise<void> {
        if (this.isRunning) {
            logger.warn('纯净RPC合约监控器已在运行');
            return;
        }

        logger.info('🚀 启动纯净RPC合约监控器');
        this.isRunning = true;
        this.stats.lastSuccessfulPoll = Date.now();

        try {
            // 测试API连接
            logger.info('🔧 测试官方Hyperliquid API连接...');
            const testMeta = await this.infoClient.meta();
            logger.info('✅ 官方API连接成功', {
                universeLength: testMeta.universe?.length || 0,
                sampleAssets: testMeta.universe?.slice(0, 3).map(u => u.name) || []
            });

            // 测试单个用户数据获取
            if (this.traders.length > 0) {
                const testTrader = this.traders[0];
                logger.info(`🔍 测试获取${testTrader.label}数据...`);
                
                const endTime = Math.floor(Date.now() / 1000);
                const startTime = endTime - 3600; // 1小时前
                
                const testFills = await this.infoClient.userFillsByTime({
                    user: testTrader.address as `0x${string}`,
                    startTime,
                    endTime
                });
                
                logger.info(`📊 ${testTrader.label}测试结果`, {
                    fillsCount: testFills?.length || 0,
                    timeRange: '最近1小时'
                });
            }

            // 为每个交易员启动独立的轮询
            for (const trader of this.traders) {
                this.startTraderPolling(trader);
            }

            // 启动健康监控
            this.startHealthMonitoring();

            logger.info('✅ 纯净RPC合约监控器启动成功', {
                activeTraders: this.traders.length,
                strategy: 'pure-official-api-polling',
                pollingInterval: `${this.POLLING_INTERVAL / 1000}s`
            });

        } catch (error) {
            logger.error('纯净RPC合约监控器启动失败:', error);
            this.isRunning = false;
            throw error;
        }
    }

    private startTraderPolling(trader: ContractTrader): void {
        const pollTrader = async () => {
            if (!this.isRunning) return;

            try {
                await this.pollTraderFills(trader);
                this.stats.consecutiveErrors = 0;
                this.stats.lastSuccessfulPoll = Date.now();
            } catch (error) {
                this.stats.totalErrors++;
                this.stats.consecutiveErrors++;
                logger.error(`${trader.label}轮询失败:`, error);
                
                // 如果连续错误太多，增加延迟
                if (this.stats.consecutiveErrors > 3) {
                    logger.warn(`${trader.label}连续错误过多，暂停轮询30秒`);
                    setTimeout(() => {
                        if (this.isRunning) {
                            this.startTraderPolling(trader);
                        }
                    }, 30000);
                    return;
                }
            }
        };

        // 立即执行一次，然后设置定时轮询
        pollTrader();
        
        const interval = setInterval(pollTrader, this.POLLING_INTERVAL);
        this.pollingIntervals.push(interval);
    }

    private async pollTraderFills(trader: ContractTrader): Promise<void> {
        this.stats.totalRequests++;
        
        const startTime = this.lastProcessedTime.get(trader.address) || Date.now() - 60 * 60 * 1000;
        const endTime = Date.now();
        
        try {
            logger.info(`🔍 轮询${trader.label}交易数据`, {
                address: trader.address,
                startTime: new Date(startTime).toISOString(),
                endTime: new Date(endTime).toISOString(),
                timeRangeMinutes: Math.round((endTime - startTime) / (60 * 1000))
            });

            // 获取指定时间范围内的用户填充数据
            const fills = await this.infoClient.userFillsByTime({
                user: trader.address as `0x${string}`,
                startTime: Math.floor(startTime / 1000),
                endTime: Math.floor(endTime / 1000)
            });

            // 详细记录API响应
            logger.info(`📡 ${trader.label} API响应`, {
                address: trader.address,
                fillsCount: fills?.length || 0,
                timeRangeMinutes: Math.round((endTime - startTime) / (60 * 1000))
            });

            if (fills && fills.length > 0) {
                logger.info(`📊 ${trader.label}获取到${fills.length}条交易数据`, {
                    fillsCount: fills.length,
                    firstFill: {
                        time: new Date(fills[0].time).toISOString(),
                        coin: fills[0].coin,
                        side: fills[0].side,
                        size: fills[0].sz,
                        user: (fills[0] as any).user
                    },
                    lastFill: {
                        time: new Date(fills[fills.length - 1].time).toISOString(),
                        coin: fills[fills.length - 1].coin,
                        side: fills[fills.length - 1].side,
                        size: fills[fills.length - 1].sz,
                        user: (fills[fills.length - 1] as any).user
                    }
                });

                // 按时间排序，确保按顺序处理
                fills.sort((a, b) => a.time - b.time);

                // 处理每个填充
                for (const fill of fills) {
                    await this.processFill(fill, trader);
                }

                this.stats.tradesProcessed += fills.length;
            } else {
                logger.debug(`💤 ${trader.label} 当前时间范围内无交易`);
            }

            // 更新最后处理时间
            this.lastProcessedTime.set(trader.address, endTime);

        } catch (error) {
            logger.error(`${trader.label}数据获取失败:`, error);
            throw error;
        }
    }

    private async processFill(fill: any, trader: ContractTrader): Promise<void> {
        try {
            // 验证填充数据
            if (!this.validateFill(fill, trader)) {
                return;
            }

            const coin = fill.coin;
            const size = parseFloat(fill.sz || '0');
            const price = parseFloat(fill.px || '0');
            const notionalValue = Math.abs(size) * price;

            // 检查最小名义价值阈值
            if (notionalValue < this.minNotionalValue) {
                logger.debug(`${trader.label}交易名义价值${notionalValue}低于阈值${this.minNotionalValue}，跳过`);
                return;
            }

            logger.info(`📈 处理${trader.label}交易`, {
                asset: coin,
                size: size,
                price: price,
                notionalValue: notionalValue,
                oid: fill.oid,
                side: fill.side,
                time: new Date(fill.time).toISOString()
            });

            // 简化处理：直接发射事件，不聚合
            const signal = this.convertFillToContractSignal(fill, trader);
            if (signal) {
                signal.metadata = {
                    ...signal.metadata,
                    source: 'pure-rpc-api'
                };
                
                this.emit('contractEvent', signal, trader);
                this.stats.totalEvents++;
            }

        } catch (error) {
            logger.error(`处理${trader.label}填充失败:`, error, { fill });
        }
    }

    private validateFill(fill: any, trader: ContractTrader): boolean {
        // 验证基本字段
        if (!fill.coin || !fill.sz || !fill.px) {
            logger.debug(`${trader.label}填充数据不完整，跳过:`, {
                coin: fill.coin,
                sz: fill.sz,
                px: fill.px
            });
            return false;
        }

        // 验证用户地址匹配（关键检查）
        if ((fill as any).user && (fill as any).user.toLowerCase() !== trader.address.toLowerCase()) {
            logger.debug(`${trader.label}地址不匹配，跳过: ${(fill as any).user} != ${trader.address}`);
            return false;
        }

        // 跳过现货交易（以@开头的资产）
        if (fill.coin.startsWith('@')) {
            logger.debug(`${trader.label}跳过现货交易: ${fill.coin}`);
            return false;
        }

        return true;
    }

    private convertFillToContractSignal(fill: any, trader: ContractTrader): ContractEvent | null {
        try {
            const coin = fill.coin;
            const size = parseFloat(fill.sz || '0');
            const price = parseFloat(fill.px || '0');
            const side = fill.side === 'B' ? 'long' : 'short';
            const notionalValue = Math.abs(size) * price;

            let eventType: 'position_open_long' | 'position_open_short' | 'position_close' | 'position_increase' | 'position_decrease';
            if (side === 'long') {
                eventType = 'position_open_long';
            } else {
                eventType = 'position_open_short';
            }

            let blockTime: number;
            if (fill.time) {
                blockTime = fill.time > 1e12 ? Math.floor(fill.time / 1000) : Math.floor(fill.time);
            } else {
                blockTime = Math.floor(Date.now() / 1000);
            }

            const result: ContractEvent = {
                timestamp: Date.now(),
                address: trader.address,
                eventType,
                asset: coin,
                size: Math.abs(size).toString(),
                price: price.toString(),
                side,
                hash: fill.hash || fill.tid || `pure_rpc_${Date.now()}_${coin}`,
                blockTime: blockTime,
                metadata: {
                    notionalValue: notionalValue.toString(),
                    originalAsset: coin,
                    source: 'pure-rpc-api',
                    isRealTime: false,
                    fillType: fill.side,
                    originalFill: fill,
                    oid: fill.oid
                }
            };

            return result;

        } catch (error) {
            logger.error(`转换Fill事件失败 (${trader.label}):`, error);
            return null;
        }
    }

    createWebhookAlert(event: ContractEvent, trader: ContractTrader): ContractWebhookAlert {
        return {
            timestamp: event.timestamp,
            alertType: event.eventType as any,
            address: event.address,
            traderLabel: trader.label,
            asset: event.asset,
            size: event.size,
            price: event.price,
            side: event.side,
            txHash: event.hash,
            blockTime: event.blockTime,
            positionSizeAfter: event.positionSizeAfter,
            notionalValue: event.metadata?.notionalValue,
            leverage: event.metadata?.leverage,
            mergedCount: 1,
            originalFillsCount: 1,
            isMerged: false
        };
    }

    private startHealthMonitoring(): void {
        const healthInterval = setInterval(() => {
            if (!this.isRunning) {
                clearInterval(healthInterval);
                return;
            }

            const timeSinceLastPoll = Date.now() - this.stats.lastSuccessfulPoll;
            const isHealthy = timeSinceLastPoll < this.POLLING_INTERVAL * 2;

            logger.info('📊 纯净RPC合约监控状态报告', {
                uptime: Math.floor((Date.now() - this.startTime) / 1000) + 's',
                isHealthy,
                totalTraders: this.traders.length,
                totalRequests: this.stats.totalRequests,
                totalErrors: this.stats.totalErrors,
                totalEvents: this.stats.totalEvents,
                tradesProcessed: this.stats.tradesProcessed,
                consecutiveErrors: this.stats.consecutiveErrors,
                lastSuccessfulPoll: Math.floor(timeSinceLastPoll / 1000) + 's ago',
                successRate: this.stats.totalRequests > 0 ? 
                    Math.round(((this.stats.totalRequests - this.stats.totalErrors) / this.stats.totalRequests) * 100) + '%' : 'N/A'
            });

        }, 60000); // 每分钟报告一次状态

        this.pollingIntervals.push(healthInterval);
    }

    async stop(): Promise<void> {
        if (!this.isRunning) {
            return;
        }

        logger.info('⏹️ 停止纯净RPC合约监控器');
        this.isRunning = false;

        try {
            // 清理定时器
            this.pollingIntervals.forEach(interval => clearInterval(interval));
            this.pollingIntervals = [];

            logger.info('✅ 纯净RPC合约监控器已停止', {
                finalStats: this.stats
            });

        } catch (error) {
            logger.warn('⚠️ 停止过程中出现错误:', error);
        }
    }

    getStats() {
        return {
            isRunning: this.isRunning,
            strategy: 'pure-rpc-official-api',
            traders: this.traders.length,
            startTime: this.startTime,
            uptime: this.isRunning ? Date.now() - this.startTime : 0,
            pollingInterval: this.POLLING_INTERVAL,
            stats: this.stats,
            successRate: this.stats.totalRequests > 0 ? 
                Math.round(((this.stats.totalRequests - this.stats.totalErrors) / this.stats.totalRequests) * 100) : 0
        };
    }

    getStatus() {
        const timeSinceLastPoll = Date.now() - this.stats.lastSuccessfulPoll;

        return {
            isRunning: this.isRunning,
            monitoringMode: 'pure-rpc',
            isHealthy: timeSinceLastPoll < this.POLLING_INTERVAL * 2,
            totalTraders: this.traders.length,
            pollingInterval: this.POLLING_INTERVAL,
            stats: this.stats,
            lastPollAge: Math.floor(timeSinceLastPoll / 1000),
            uptime: this.isRunning ? Date.now() - this.startTime : 0,
            traders: this.traders.map(trader => ({
                label: trader.label,
                address: trader.address.slice(0, 8) + '...',
                lastProcessed: this.lastProcessedTime.get(trader.address) || 0
            }))
        };
    }

    getTotalSubscriptions(): number {
        return this.traders.length;
    }
}

export default PureRpcContractMonitor;