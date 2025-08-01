import { EventEmitter } from 'events';
import { ContractTrader, ContractEvent, ContractWebhookAlert } from '../types';
import logger from '../logger';
import config from '../config';
import * as hl from '@nktkas/hyperliquid';

/**
 * RPC合约监控器
 * 采用HTTP轮询策略，避免WebSocket连接不稳定问题
 * 内置订单聚合机制，解决大订单子成交重复警报问题
 */
export class RpcContractMonitor extends EventEmitter {
    private traders: ContractTrader[];
    private minNotionalValue: number;
    private isRunning = false;
    private startTime: number;
    private infoClient: hl.InfoClient;
    private pollingIntervals: NodeJS.Timeout[] = [];
    
    // 轮询配置
    private readonly POLLING_INTERVAL = 15000; // 15秒轮询间隔
    private readonly ERROR_RETRY_DELAY = 30000; // 错误重试延迟30秒
    private readonly MAX_RETRIES = 3; // 最大重试次数
    
    // 订单聚合管理
    private lastProcessedTime = new Map<string, number>(); // 每个交易员的最后处理时间
    private pendingOrderFills = new Map<string, {
        oid: number;
        trader: ContractTrader;
        fills: any[];
        totalSize: number;
        avgPrice: number;
        firstFill: any;
        lastUpdate: number;
        side: 'long' | 'short';
        asset: string;
    }>();
    private readonly ORDER_COMPLETION_DELAY = 5000; // 5秒订单完成延迟
    
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

    constructor(traders: ContractTrader[], minNotionalValue = 100) {
        super();
        this.traders = traders.filter(t => t.isActive);
        this.minNotionalValue = minNotionalValue;
        this.startTime = Date.now();
        
        // 初始化HTTP transport和InfoClient
        // 注意：必须使用官方Hyperliquid API，Alchemy节点不支持userFillsByTime
        logger.info('📡 初始化官方Hyperliquid API连接');
        const transport = new hl.HttpTransport({
            timeout: 30000, // 30秒超时
            isTestnet: false,
            // 添加请求和响应回调用于调试
            onRequest: (request) => {
                logger.debug('🌐 API请求详情', {
                    url: request.url,
                    method: request.method,
                    headers: Object.fromEntries(request.headers.entries()),
                    // 避免记录敏感数据，只记录请求的基本信息
                });
                return request;
            },
            onResponse: (response) => {
                logger.debug('📥 API响应详情', {
                    status: response.status,
                    statusText: response.statusText,
                    headers: Object.fromEntries(response.headers.entries()),
                    url: response.url
                });
                return response;
            }
        });
        this.infoClient = new hl.InfoClient({ transport });
        
        // 初始化每个交易员的最后处理时间（从24小时前开始，确保能获取到数据）
        const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
        this.traders.forEach(trader => {
            this.lastProcessedTime.set(trader.address, twentyFourHoursAgo);
        });

        logger.info('🔄 初始化RPC合约监控器', {
            activeTraders: this.traders.length,
            minNotionalValue,
            strategy: 'HTTP轮询 + 订单聚合 (官方API)',
            pollingInterval: `${this.POLLING_INTERVAL / 1000}s`,
            orderCompletionDelay: `${this.ORDER_COMPLETION_DELAY / 1000}s`,
            note: 'Alchemy节点暂时不可用于userFillsByTime API，使用官方API'
        });
    }

    async start(): Promise<void> {
        if (this.isRunning) {
            logger.warn('RPC合约监控器已在运行');
            return;
        }

        logger.info('🚀 启动RPC合约监控器');
        this.isRunning = true;
        this.stats.lastSuccessfulPoll = Date.now();

        try {
            // 测试API连接
            logger.info('🔧 测试Hyperliquid API连接...');
            const testMeta = await this.infoClient.meta();
            logger.info('✅ API连接成功', {
                universeLength: testMeta.universe?.length || 0,
                sampleAssets: testMeta.universe?.slice(0, 3).map(u => u.name) || []
            });

            // 为每个交易员启动独立的轮询
            for (const trader of this.traders) {
                this.startTraderPolling(trader);
            }

            // 启动订单聚合检查器
            this.startOrderAggregationChecker();

            // 启动健康监控
            this.startHealthMonitoring();

            logger.info('✅ RPC合约监控器启动成功', {
                activeTraders: this.traders.length,
                strategy: 'independent-polling-per-trader',
                pollingInterval: `${this.POLLING_INTERVAL / 1000}s`
            });

        } catch (error) {
            logger.error('RPC合约监控器启动失败:', error);
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
        
        const startTime = this.lastProcessedTime.get(trader.address) || Date.now() - 5 * 60 * 1000;
        const endTime = Date.now();
        const timeRangeMinutes = Math.round((endTime - startTime) / (60 * 1000) * 10) / 10;
        
        try {
            logger.info(`🔍 轮询${trader.label}交易数据`, {
                address: trader.address,
                startTime: new Date(startTime).toISOString(),
                endTime: new Date(endTime).toISOString(),
                timeRangeMinutes
            });

            // 检查请求参数
            const requestParams = {
                user: trader.address as `0x${string}`,
                startTime: startTime, // 保持毫秒时间戳
                endTime: endTime,
                aggregateByTime: true // 启用时间聚合，合并部分成交
            };

            logger.debug(`📤 API请求参数 ${trader.label}`, requestParams);

            // 并行获取填充数据
            const fills = await this.infoClient.userFillsByTime(requestParams);

            // 详细记录API响应
            logger.info(`📡 ${trader.label} API响应`, {
                address: trader.address,
                fillsCount: fills?.length || 0,
                timeRangeMinutes,
                rawFillsSample: fills?.slice(0, 2) || []
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
            }

            // 更新最后处理时间
            this.lastProcessedTime.set(trader.address, endTime);

        } catch (error: any) {
            // 详细错误日志
            logger.error(`${trader.label}数据获取失败:`, {
                errorMessage: error.message,
                errorName: error.name,
                errorStack: error.stack,
                responseStatus: error.response?.status,
                responseBody: error.responseBody,
                requestParams: {
                    user: trader.address,
                    startTime: startTime,
                    endTime: endTime
                }
            });

            // 如果是401错误，提供更多调试信息
            if (error.message?.includes('401') || error.message?.includes('Must be authenticated')) {
                logger.error(`🔐 ${trader.label} 认证错误分析`, {
                    errorType: '401 Unauthorized',
                    possibleCauses: [
                        'API节点可能需要认证',
                        '请求格式可能不正确',
                        'API服务器临时问题'
                    ],
                    troubleshooting: {
                        checkApiEndpoint: 'https://api.hyperliquid.xyz/info',
                        checkRequestFormat: 'userFillsByTime不应需要认证',
                        suggestedAction: '尝试直接curl测试API'
                    }
                });
            }

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

            logger.debug(`📈 处理${trader.label}交易`, {
                asset: coin,
                size: size,
                price: price,
                notionalValue: notionalValue,
                oid: fill.oid,
                side: fill.side
            });

            // 订单聚合处理
            if (fill.oid) {
                await this.handleOrderAggregation(fill, trader);
            } else {
                // 没有订单ID的直接处理
                await this.processSingleFill(fill, trader);
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
                px: fill.px,
                rawFill: fill
            });
            return false;
        }

        // 验证用户地址匹配（这是关键检查）
        if (fill.user && fill.user.toLowerCase() !== trader.address.toLowerCase()) {
            logger.info(`❌ ${trader.label}地址不匹配，跳过:`, {
                fillUser: fill.user,
                expectedTrader: trader.address,
                fillData: fill
            });
            return false;
        }

        // 如果fill.user为空，记录警告
        if (!fill.user) {
            logger.warn(`⚠️ ${trader.label}填充中没有用户地址:`, fill);
        }

        // 跳过现货交易（以@开头的资产）
        if (fill.coin.startsWith('@')) {
            logger.debug(`${trader.label}跳过现货交易: ${fill.coin}`);
            return false;
        }

        return true;
    }

    private async handleOrderAggregation(fill: any, trader: ContractTrader): Promise<void> {
        const oid = fill.oid;
        const key = `${trader.address}-${oid}`;
        const side = fill.side === 'B' ? 'long' : 'short';

        if (!this.pendingOrderFills.has(key)) {
            // 创建新的聚合订单
            this.pendingOrderFills.set(key, {
                oid: oid,
                trader: trader,
                fills: [fill],
                totalSize: Math.abs(parseFloat(fill.sz)),
                avgPrice: parseFloat(fill.px),
                firstFill: fill,
                lastUpdate: Date.now(),
                side: side,
                asset: fill.coin
            });

            logger.debug(`🆕 创建新聚合订单 ${trader.label} OID:${oid}`, {
                asset: fill.coin,
                side: side,
                initialSize: fill.sz,
                price: fill.px
            });
        } else {
            // 更新现有聚合订单
            const pending = this.pendingOrderFills.get(key)!;
            pending.fills.push(fill);

            const newSize = Math.abs(parseFloat(fill.sz));
            const newPrice = parseFloat(fill.px);
            
            // 计算加权平均价格
            pending.avgPrice = (pending.avgPrice * pending.totalSize + newPrice * newSize) / (pending.totalSize + newSize);
            pending.totalSize += newSize;
            pending.lastUpdate = Date.now();

            logger.debug(`📊 更新聚合订单 ${trader.label} OID:${oid}`, {
                fillsCount: pending.fills.length,
                totalSize: pending.totalSize,
                avgPrice: pending.avgPrice
            });
        }

        // 设置订单完成检查
        setTimeout(() => {
            this.checkCompletedOrder(key);
        }, this.ORDER_COMPLETION_DELAY);
    }

    private checkCompletedOrder(key: string): void {
        const pending = this.pendingOrderFills.get(key);
        if (!pending) return;

        const now = Date.now();
        if (now - pending.lastUpdate >= this.ORDER_COMPLETION_DELAY) {
            logger.info(`✅ 订单聚合完成 ${pending.trader.label} OID:${pending.oid}`, {
                asset: pending.asset,
                totalFills: pending.fills.length,
                totalSize: pending.totalSize,
                avgPrice: pending.avgPrice,
                timespan: now - pending.fills[0].time
            });

            this.emitAggregatedOrder(pending);
            this.pendingOrderFills.delete(key);
            this.stats.totalAggregatedOrders++;
        }
    }

    private emitAggregatedOrder(aggregatedOrder: any): void {
        const fill = aggregatedOrder.firstFill;
        const trader = aggregatedOrder.trader;

        // 创建聚合后的填充对象
        const aggregatedFill = {
            ...fill,
            sz: aggregatedOrder.totalSize.toString(),
            px: aggregatedOrder.avgPrice.toString(),
            isAggregated: true,
            originalFillsCount: aggregatedOrder.fills.length,
            aggregatedSize: aggregatedOrder.totalSize,
            aggregatedPrice: aggregatedOrder.avgPrice
        };

        const signal = this.convertFillToContractSignal(aggregatedFill, trader);
        if (signal) {
            signal.metadata = {
                ...signal.metadata,
                isAggregated: true,
                originalFillsCount: aggregatedOrder.fills.length,
                aggregationTimespan: Date.now() - aggregatedOrder.fills[0].time,
                source: 'rpc-aggregated'
            };

            this.emit('contractEvent', signal, trader);
            this.stats.totalEvents++;
        }
    }

    private async processSingleFill(fill: any, trader: ContractTrader): Promise<void> {
        const signal = this.convertFillToContractSignal(fill, trader);
        if (signal) {
            signal.metadata = {
                ...signal.metadata,
                source: 'rpc-single'
            };
            
            this.emit('contractEvent', signal, trader);
            this.stats.totalEvents++;
        }
    }

    private convertFillToContractSignal(fill: any, trader: ContractTrader): ContractEvent | null {
        try {
            const coin = fill.coin;
            if (!coin || typeof coin !== 'string' || coin.startsWith('@')) {
                return null;
            }

            const size = parseFloat(fill.sz || '0');
            const price = parseFloat(fill.px || '0');
            const side = fill.side === 'B' ? 'long' : 'short';
            const notionalValue = Math.abs(size) * price;

            if (notionalValue < this.minNotionalValue) {
                return null;
            }

            let eventType: 'position_open_long' | 'position_open_short' | 'position_close' | 'position_increase' | 'position_decrease';
            if (side === 'long') {
                eventType = 'position_open_long';
            } else {
                eventType = 'position_open_short';
            }

            // 处理时间戳
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
                hash: fill.hash || fill.tid || `rpc_fill_${Date.now()}_${coin}`,
                blockTime: blockTime,
                metadata: {
                    notionalValue: notionalValue.toString(),
                    originalAsset: coin,
                    source: 'rpc-fills',
                    isRealTime: false, // RPC是轮询，不是实时
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
        const isAggregated = event.metadata?.isAggregated || false;
        const originalFillsCount = event.metadata?.originalFillsCount || 1;

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
            mergedCount: originalFillsCount,
            originalFillsCount: originalFillsCount,
            isMerged: isAggregated
        };
    }

    private startOrderAggregationChecker(): void {
        const checkInterval = setInterval(() => {
            if (!this.isRunning) {
                clearInterval(checkInterval);
                return;
            }

            // 检查所有待聚合的订单
            const now = Date.now();
            const completedKeys: string[] = [];

            for (const [key, pending] of this.pendingOrderFills.entries()) {
                if (now - pending.lastUpdate >= this.ORDER_COMPLETION_DELAY) {
                    completedKeys.push(key);
                }
            }

            // 处理完成的订单
            for (const key of completedKeys) {
                this.checkCompletedOrder(key);
            }

        }, this.ORDER_COMPLETION_DELAY / 2); // 每2.5秒检查一次

        this.pollingIntervals.push(checkInterval);
    }

    private startHealthMonitoring(): void {
        const healthInterval = setInterval(() => {
            if (!this.isRunning) {
                clearInterval(healthInterval);
                return;
            }

            const timeSinceLastPoll = Date.now() - this.stats.lastSuccessfulPoll;
            const isHealthy = timeSinceLastPoll < this.POLLING_INTERVAL * 3; // 3个轮询周期内有成功

            logger.info('📊 RPC合约监控状态报告', {
                uptime: Math.floor((Date.now() - this.startTime) / 1000) + 's',
                isHealthy,
                totalTraders: this.traders.length,
                totalRequests: this.stats.totalRequests,
                totalErrors: this.stats.totalErrors,
                totalEvents: this.stats.totalEvents,
                totalAggregatedOrders: this.stats.totalAggregatedOrders,
                tradesProcessed: this.stats.tradesProcessed,
                consecutiveErrors: this.stats.consecutiveErrors,
                lastSuccessfulPoll: Math.floor(timeSinceLastPoll / 1000) + 's ago',
                pendingOrders: this.pendingOrderFills.size,
                successRate: this.stats.totalRequests > 0 ? 
                    Math.round(((this.stats.totalRequests - this.stats.totalErrors) / this.stats.totalRequests) * 100) + '%' : 'N/A'
            });

            // 如果长时间没有成功轮询，记录警告
            if (timeSinceLastPoll > this.POLLING_INTERVAL * 5) {
                logger.warn('⚠️ RPC监控器长时间未成功轮询', {
                    timeSinceLastPoll: Math.floor(timeSinceLastPoll / 1000) + 's',
                    consecutiveErrors: this.stats.consecutiveErrors
                });
            }

        }, 60000); // 每分钟报告一次状态

        this.pollingIntervals.push(healthInterval);
    }

    async stop(): Promise<void> {
        if (!this.isRunning) {
            return;
        }

        logger.info('⏹️ 停止RPC合约监控器');
        this.isRunning = false;

        try {
            // 清理所有定时器
            this.pollingIntervals.forEach(interval => clearInterval(interval));
            this.pollingIntervals = [];

            // 处理剩余的待聚合订单
            const pendingCount = this.pendingOrderFills.size;
            if (pendingCount > 0) {
                logger.info(`🧹 处理${pendingCount}个待聚合订单`);
                
                for (const [key, pending] of this.pendingOrderFills.entries()) {
                    this.emitAggregatedOrder(pending);
                }
                
                this.pendingOrderFills.clear();
            }

            logger.info('✅ RPC合约监控器已停止', {
                finalStats: this.stats
            });

        } catch (error) {
            logger.warn('⚠️ 停止过程中出现错误:', error);
        }
    }

    getStats() {
        return {
            isRunning: this.isRunning,
            strategy: 'rpc-polling-with-aggregation',
            traders: this.traders.length,
            startTime: this.startTime,
            uptime: this.isRunning ? Date.now() - this.startTime : 0,
            pollingInterval: this.POLLING_INTERVAL,
            orderCompletionDelay: this.ORDER_COMPLETION_DELAY,
            stats: this.stats,
            pendingOrders: this.pendingOrderFills.size,
            successRate: this.stats.totalRequests > 0 ? 
                Math.round(((this.stats.totalRequests - this.stats.totalErrors) / this.stats.totalRequests) * 100) : 0
        };
    }

    getStatus() {
        const timeSinceLastPoll = Date.now() - this.stats.lastSuccessfulPoll;

        return {
            isRunning: this.isRunning,
            monitoringMode: 'rpc-polling',
            isHealthy: timeSinceLastPoll < this.POLLING_INTERVAL * 3,
            totalTraders: this.traders.length,
            pollingInterval: this.POLLING_INTERVAL,
            stats: this.stats,
            lastPollAge: Math.floor(timeSinceLastPoll / 1000),
            uptime: this.isRunning ? Date.now() - this.startTime : 0,
            pendingOrders: this.pendingOrderFills.size,
            traders: this.traders.map(trader => ({
                label: trader.label,
                address: trader.address.slice(0, 8) + '...',
                lastProcessed: this.lastProcessedTime.get(trader.address) || 0
            }))
        };
    }

    getTotalSubscriptions(): number {
        return this.traders.length; // RPC模式下没有订阅概念，返回交易员数量
    }
}

export default RpcContractMonitor;
