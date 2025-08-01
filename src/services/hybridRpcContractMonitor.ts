import { EventEmitter } from 'events';
import { ContractTrader, ContractEvent, ContractWebhookAlert } from '../types';
import logger from '../logger';
import config from '../config';
import * as hl from '@nktkas/hyperliquid';
import { ethers, JsonRpcProvider } from 'ethers';

/**
 * 混合RPC合约监控器
 * 使用官方API获取填充数据 + Alchemy节点监控链上事件
 */
export class HybridRpcContractMonitor extends EventEmitter {
    private traders: ContractTrader[];
    private minNotionalValue: number;
    private isRunning = false;
    private startTime: number;
    private infoClient: hl.InfoClient;
    private alchemyProvider: JsonRpcProvider;
    private pollingIntervals: NodeJS.Timeout[] = [];
    
    // 轮询配置
    private readonly POLLING_INTERVAL = 15000; // 15秒轮询间隔
    private readonly ORDER_COMPLETION_DELAY = 5000; // 5秒订单完成延迟
    
    // 订单聚合管理
    private lastProcessedTime = new Map<string, number>();
    private pendingOrderFills = new Map<string, any>();
    
    // 统计信息
    private stats = {
        totalRequests: 0,
        totalErrors: 0,
        totalEvents: 0,
        totalAggregatedOrders: 0,
        lastSuccessfulPoll: 0,
        consecutiveErrors: 0,
        tradesProcessed: 0,
        alchemyBlocks: 0
    };

    constructor(traders: ContractTrader[], minNotionalValue = 100) {
        super();
        this.traders = traders.filter(t => t.isActive);
        this.minNotionalValue = minNotionalValue;
        this.startTime = Date.now();
        
        // 1. 官方API用于获取填充数据
        const transport = new hl.HttpTransport({
            timeout: 30000,
            isTestnet: false
        });
        this.infoClient = new hl.InfoClient({ transport });
        
        // 2. 你的Alchemy节点用于监控链上事件
        this.alchemyProvider = new JsonRpcProvider(
            'https://hyperliquid-mainnet.g.alchemy.com/v2/5iQ4gLKfe38KwmSu4X1Hn'
        );
        
        // 初始化时间
        const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
        this.traders.forEach(trader => {
            this.lastProcessedTime.set(trader.address, twentyFourHoursAgo);
        });

        logger.info('🔄 初始化混合RPC合约监控器', {
            activeTraders: this.traders.length,
            minNotionalValue,
            strategy: '官方API + Alchemy链上监控',
            pollingInterval: `${this.POLLING_INTERVAL / 1000}s`,
            alchemyNode: '配置完成'
        });
    }

    async start(): Promise<void> {
        if (this.isRunning) {
            logger.warn('混合RPC合约监控器已在运行');
            return;
        }

        logger.info('🚀 启动混合RPC合约监控器');
        this.isRunning = true;
        this.stats.lastSuccessfulPoll = Date.now();

        try {
            // 测试Alchemy连接
            const blockNumber = await this.alchemyProvider.getBlockNumber();
            logger.info('✅ Alchemy节点连接成功', {
                currentBlock: blockNumber,
                network: await this.alchemyProvider.getNetwork()
            });

            // 启动官方API轮询
            for (const trader of this.traders) {
                this.startTraderPolling(trader);
            }

            // 启动Alchemy链上监控
            this.startAlchemyMonitoring();

            // 启动订单聚合检查器
            this.startOrderAggregationChecker();

            // 启动健康监控
            this.startHealthMonitoring();

            logger.info('✅ 混合RPC合约监控器启动成功', {
                activeTraders: this.traders.length,
                strategy: 'hybrid-official-api-alchemy',
                pollingInterval: `${this.POLLING_INTERVAL / 1000}s`
            });

        } catch (error) {
            logger.error('混合RPC合约监控器启动失败:', error);
            this.isRunning = false;
            throw error;
        }
    }

    private async startAlchemyMonitoring(): Promise<void> {
        try {
            // 监听新区块
            this.alchemyProvider.on('block', (blockNumber: number) => {
                this.stats.alchemyBlocks++;
                logger.debug(`📦 新区块: ${blockNumber}`);
            });

            logger.info('🔗 Alchemy链上监控启动成功');
        } catch (error) {
            logger.error('❌ Alchemy链上监控启动失败:', error);
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
                if (this.stats.consecutiveErrors > 5) {
                    logger.warn(`${trader.label}连续错误过多，暂停轮询60秒`);
                    setTimeout(() => {
                        if (this.isRunning) {
                            this.startTraderPolling(trader);
                        }
                    }, 60000);
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
        
        const startTime = this.lastProcessedTime.get(trader.address) || Date.now() - 24 * 60 * 60 * 1000;
        const endTime = Date.now();
        
        try {
            logger.info(`🔍 轮询${trader.label}交易数据 (官方API)`, {
                address: trader.address,
                startTime: new Date(startTime).toISOString(),
                endTime: new Date(endTime).toISOString(),
                timeRangeHours: Math.round((endTime - startTime) / (60 * 60 * 1000) * 10) / 10
            });

            // 使用官方API获取填充数据
            const fills = await this.infoClient.userFillsByTime({
                user: trader.address as `0x${string}`,
                startTime: startTime, // 保持毫秒时间戳
                endTime: endTime,     // 保持毫秒时间戳
                aggregateByTime: true // 启用时间聚合，合并部分成交
            });

            // 详细记录API响应
            logger.info(`📡 ${trader.label} 官方API响应`, {
                address: trader.address,
                fillsCount: fills?.length || 0,
                timeRangeHours: Math.round((endTime - startTime) / (60 * 60 * 1000) * 10) / 10
            });

            if (fills && fills.length > 0) {
                logger.info(`📊 ${trader.label}获取到${fills.length}条交易数据`, {
                    timeRange: `${new Date(startTime).toISOString()} ~ ${new Date(endTime).toISOString()}`,
                    fillsCount: fills.length,
                    firstFill: fills[0],
                    lastFill: fills[fills.length - 1]
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

            // 检查最小名义价值阈值（临时降低阈值用于调试）
            const debugMinNotional = 1; // 临时设为1美元，确保能捕获所有交易
            if (notionalValue < debugMinNotional) {
                logger.debug(`${trader.label}交易名义价值${notionalValue}低于调试阈值${debugMinNotional}，跳过`);
                return;
            }

            logger.info(`📈 处理${trader.label}交易`, {
                asset: coin,
                size: size,
                price: price,
                notionalValue: notionalValue,
                oid: fill.oid,
                side: fill.side
            });

            // 发射事件（简化版，先不聚合）
            const signal = this.convertFillToContractSignal(fill, trader);
            if (signal) {
                signal.metadata = {
                    ...signal.metadata,
                    source: 'hybrid-official-api'
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
            logger.info(`${trader.label}填充数据不完整，跳过:`, {
                coin: fill.coin,
                sz: fill.sz,
                px: fill.px
            });
            return false;
        }

        // 验证用户地址匹配（这是关键检查）
        if (fill.user && fill.user.toLowerCase() !== trader.address.toLowerCase()) {
            logger.info(`❌ ${trader.label}地址不匹配，跳过:`, {
                fillUser: fill.user,
                expectedTrader: trader.address
            });
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
                hash: fill.hash || fill.tid || `hybrid_fill_${Date.now()}_${coin}`,
                blockTime: blockTime,
                metadata: {
                    notionalValue: notionalValue.toString(),
                    originalAsset: coin,
                    source: 'hybrid-official-api',
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

    private startOrderAggregationChecker(): void {
        // 简化版暂时不实现
    }

    private startHealthMonitoring(): void {
        const healthInterval = setInterval(() => {
            if (!this.isRunning) {
                clearInterval(healthInterval);
                return;
            }

            const timeSinceLastPoll = Date.now() - this.stats.lastSuccessfulPoll;
            const isHealthy = timeSinceLastPoll < this.POLLING_INTERVAL * 3;

            logger.info('📊 混合RPC合约监控状态报告', {
                uptime: Math.floor((Date.now() - this.startTime) / 1000) + 's',
                isHealthy,
                totalTraders: this.traders.length,
                totalRequests: this.stats.totalRequests,
                totalErrors: this.stats.totalErrors,
                totalEvents: this.stats.totalEvents,
                tradesProcessed: this.stats.tradesProcessed,
                consecutiveErrors: this.stats.consecutiveErrors,
                lastSuccessfulPoll: Math.floor(timeSinceLastPoll / 1000) + 's ago',
                alchemyBlocks: this.stats.alchemyBlocks,
                successRate: this.stats.totalRequests > 0 ? 
                    Math.round(((this.stats.totalRequests - this.stats.totalErrors) / this.stats.totalRequests) * 100) + '%' : 'N/A'
            });

        }, 60000);

        this.pollingIntervals.push(healthInterval);
    }

    async stop(): Promise<void> {
        if (!this.isRunning) {
            return;
        }

        logger.info('⏹️ 停止混合RPC合约监控器');
        this.isRunning = false;

        try {
            // 清理定时器
            this.pollingIntervals.forEach(interval => clearInterval(interval));
            this.pollingIntervals = [];

            // 断开Alchemy连接
            this.alchemyProvider.removeAllListeners();

            logger.info('✅ 混合RPC合约监控器已停止', {
                finalStats: this.stats
            });

        } catch (error) {
            logger.warn('⚠️ 停止过程中出现错误:', error);
        }
    }

    getStats() {
        return {
            isRunning: this.isRunning,
            strategy: 'hybrid-official-api-alchemy',
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
            monitoringMode: 'hybrid-rpc',
            isHealthy: timeSinceLastPoll < this.POLLING_INTERVAL * 3,
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

export default HybridRpcContractMonitor;