import { EventEmitter } from 'events';
import { ContractTrader, ContractEvent, ContractWebhookAlert } from '../types';
import logger from '../logger';
import * as hl from '@nktkas/hyperliquid';
import { PositionStateManager } from '../managers/PositionStateManager';
import { TradeClassificationEngine, AnalyzedContractEvent } from '../managers/TradeClassificationEngine';
import { PositionAnalysisEngine } from '../managers/PositionAnalysisEngine';
import { TradingAnalysisSystem } from '../managers/TradingAnalysisSystem';
import { WhaleAlertFormatter } from '../formatters/WhaleAlertFormatter';

/**
 * 纯净RPC合约监控器 
 * 只使用官方Hyperliquid API，无Alchemy依赖，专注稳定性
 */
export class PureRpcContractMonitor extends EventEmitter {
    private traders: ContractTrader[];
    private minNotionalValue: number;
    private isRunning = false;
    private startTime: number;
    private systemStartTime: number; // 系统启动时间
    private infoClient: hl.InfoClient;
    private pollingIntervals: NodeJS.Timeout[] = [];

    // 交易分析组件
    private positionManager: PositionStateManager;
    private classificationEngine: TradeClassificationEngine;
    private analysisEngine: PositionAnalysisEngine;
    private alertSystem: TradingAnalysisSystem;

    // 🐋 可选：鲸鱼告警格式化器（由 TraderMonitor 外部注入，为 alertProfile='whale-watch' 的交易员服务）
    private whaleFormatter?: WhaleAlertFormatter;

    // 轮询配置 - 优化API调用频率，避免429错误
    private readonly POLLING_INTERVAL = 120000; // 保持30秒轮询间隔
    private readonly ERROR_RETRY_DELAY = 300000; // 增加错误重试延迟到120秒
    private readonly MAX_CONSECUTIVE_ERRORS = 5; // 增加到5次连续错误

    // 订单聚合管理
    private lastProcessedTime = new Map<string, number>();
    private pendingOrderFills = new Map<string, any>();
    private readonly ORDER_COMPLETION_DELAY = 3000; // 3秒订单完成延迟

    // 订单追踪缓存
    private trackedOrders = new Set<number>(); // 已追踪的订单ID
    private orderCompletionCache = new Map<number, any>(); // 订单完整信息缓存

    // 速率限制控制
    private lastApiCall = 0;
    private readonly API_RATE_LIMIT_MS = 5000; // 5秒间隔，避免429错误
    private pendingOrderQueries = new Map<number, Promise<any>>(); // 避免重复查询

    // 去重缓存，避免重复处理相同的填充
    private processedFills = new Set<string>(); // 使用 hash 或 tid 作为唯一标识
    private readonly MAX_CACHE_SIZE = 10000; // 最大缓存数量

    // 统计信息
    private stats = {
        totalRequests: 0,
        totalErrors: 0,
        totalEvents: 0,
        totalAggregatedOrders: 0,
        totalCompleteOrders: 0, // 完整订单数量
        lastSuccessfulPoll: 0,
        consecutiveErrors: 0,
        tradesProcessed: 0
    };

    constructor(traders: ContractTrader[], minNotionalValue = 1) {
        super();
        this.traders = traders.filter(t => t.isActive);
        this.minNotionalValue = minNotionalValue; // 默认1美元阈值
        this.startTime = Date.now();
        this.systemStartTime = Date.now(); // 记录系统启动时间

        // 只使用官方API
        const transport = new hl.HttpTransport({
            timeout: 15000, // 15秒超时，更短
            isTestnet: false
        });
        this.infoClient = new hl.InfoClient({ transport });

        // 初始化增强功能组件
        this.positionManager = new PositionStateManager(this.infoClient);
        this.classificationEngine = new TradeClassificationEngine(this.positionManager);
        this.analysisEngine = new PositionAnalysisEngine(this.positionManager);
        this.alertSystem = new TradingAnalysisSystem(this.analysisEngine);

        // 初始化时间：从系统启动时间开始，避免历史订单污染
        this.traders.forEach(trader => {
            this.lastProcessedTime.set(trader.address, this.systemStartTime);
        });

        logger.info('🔄 初始化纯净RPC合约监控器 (交易分析版 v2.2)', {
            activeTraders: this.traders.length,
            minNotionalValue,
            strategy: '官方API + 智能交易分类 + 持仓分析',
            pollingInterval: `${this.POLLING_INTERVAL / 1000}s`,
            orderCompletionDelay: `${this.ORDER_COMPLETION_DELAY / 1000}s`,
            systemStartTime: new Date(this.systemStartTime).toISOString(),
            historicalFilterEnabled: true, // 启用历史订单过滤
            tradingAnalysisFeatures: [
                '持仓状态管理',
                '智能交易分类',
                '多维度持仓分析',
                '增强告警系统',
                '风险评估引擎',
                '历史订单过滤' // 新增功能
            ]
        });
    }

    /**
     * 注入鲸鱼告警格式化器。
     * 为 alertProfile='whale-watch' 的交易员改用该 formatter 生成消息；
     * 未注入或未设置 profile 的交易员继续走默认 TradingAnalysisSystem。
     * 由 TraderMonitor 在初始化阶段调用一次。
     */
    setWhaleFormatter(formatter: WhaleAlertFormatter): void {
        this.whaleFormatter = formatter;
        const whaleCount = this.traders.filter(t => t.alertProfile === 'whale-watch').length;
        logger.info('🐋 已注入 WhaleAlertFormatter', {
            whaleTraders: whaleCount,
            otherTraders: this.traders.length - whaleCount
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
            // 🆕 初始化增强告警系统的统计服务
            await this.alertSystem.initialize();

            // 测试API连接（添加重试机制）
            logger.info('🔧 测试官方Hyperliquid API连接...');

            let retries = 3;
            let testMeta;

            while (retries > 0) {
                try {
                    testMeta = await this.infoClient.meta();
                    break; // 成功则退出重试循环
                } catch (error) {
                    retries--;
                    logger.warn(`🔄 API连接失败，剩余重试次数: ${retries}`, {
                        error: error instanceof Error ? error.message : error
                    });

                    if (retries > 0) {
                        await new Promise(resolve => setTimeout(resolve, 3000)); // 等待3秒后重试
                    } else {
                        throw new Error(`API连接失败，已尝试3次: ${error instanceof Error ? error.message : error}`);
                    }
                }
            }

            if (testMeta) {
                logger.info('✅ 官方API连接成功', {
                    universeLength: testMeta.universe?.length || 0,
                    sampleAssets: testMeta.universe?.slice(0, 3).map(u => u.name) || []
                });
            }

            // 测试单个用户数据获取
            if (this.traders.length > 0) {
                const testTrader = this.traders[0];
                logger.info(`🔍 测试获取${testTrader.label}数据...`);

                const endTime = Date.now(); // 保持毫秒时间戳
                const startTime = endTime - 3600000; // 1小时前（毫秒）

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

            // 预加载所有交易员的持仓数据
            logger.info('🔄 预加载交易员持仓数据...');
            const traderAddresses = this.traders.map(trader => trader.address);
            await this.positionManager.preloadUserPositions(traderAddresses);

            // 为每个交易员启动独立的轮询
            for (const trader of this.traders) {
                this.startTraderPolling(trader);
            }

            // 启动健康监控
            this.startHealthMonitoring();

            logger.info('✅ 纯净RPC合约监控器启动成功 (交易分析版)', {
                activeTraders: this.traders.length,
                strategy: 'pure-official-api-polling + trading-analysis',
                pollingInterval: `${this.POLLING_INTERVAL / 1000}s`,
                tradingAnalysisFeatures: 'enabled'
            });

        } catch (error) {
            logger.error('❌ RPC监控器初始化失败，但将继续在后台尝试', {
                error: error instanceof Error ? error.message : error
            });

            // 不直接抛出错误，而是继续启动监控器
            // 网络问题通常是暂时的，轮询中会继续重试
            this.isRunning = true;

            // 为每个交易员启动轮询（会在轮询中处理连接问题）
            for (const trader of this.traders) {
                this.startTraderPolling(trader);
            }

            // 启动健康监控
            this.startHealthMonitoring();

            logger.info('🔄 RPC监控器已启动，将在轮询中继续尝试连接');
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

                // 🔧 改进的错误处理逻辑
                const errorMessage = error instanceof Error ? error.message : String(error);

                if (errorMessage.includes('429') || errorMessage.includes('API_RATE_LIMITED')) {
                    // 429错误：API速率限制
                    const customDelay = errorMessage.includes('API_RATE_LIMITED')
                        ? parseInt(errorMessage.split('_').pop() || '60000')
                        : Math.min(60000 * Math.pow(2, this.stats.consecutiveErrors - 1), 300000);

                    logger.warn(`🚫 ${trader.label} API速率限制，暂停${customDelay / 1000}秒`, {
                        consecutiveErrors: this.stats.consecutiveErrors,
                        nextRetry: new Date(Date.now() + customDelay).toISOString()
                    });

                    setTimeout(() => {
                        if (this.isRunning) {
                            this.startTraderPolling(trader);
                        }
                    }, customDelay);
                    return;
                } else {
                    // 🔧 增强错误处理：区分网络错误和其他错误
                    const isNetworkError = this.isNetworkError(error);
                    const errorType = isNetworkError ? '网络错误' : '其他错误';

                    logger.warn(`⚠️ ${trader.label}轮询${errorType}`, {
                        error: errorMessage,
                        isNetworkError,
                        consecutiveErrors: this.stats.consecutiveErrors,
                        nextAction: isNetworkError ? '继续正常轮询' : '可能增加延迟'
                    });

                    // 🔧 对于网络错误，更宽松的处理策略
                    if (isNetworkError) {
                        // 🚨 断路器：网络错误连续超过10次，暂停5分钟
                        if (this.stats.consecutiveErrors >= 10) {
                            const pauseDuration = 5 * 60 * 1000; // 5分钟
                            logger.warn(`🚫 ${trader.label} 断路器触发（网络错误）`, {
                                consecutiveErrors: this.stats.consecutiveErrors,
                                pauseDuration: `${pauseDuration / 1000}s`,
                                nextRetry: new Date(Date.now() + pauseDuration).toISOString()
                            });
                            
                            setTimeout(() => {
                                this.stats.consecutiveErrors = 0; // 重置计数器
                                if (this.isRunning) {
                                    this.startTraderPolling(trader);
                                }
                            }, pauseDuration);
                            return; // 停止当前轮询
                        }
                        
                        // 网络错误：记录但继续运行，不增加长延迟
                        if (this.stats.consecutiveErrors > 20) {
                            logger.warn(`${trader.label}连续网络错误过多，但继续尝试`, {
                                consecutiveErrors: this.stats.consecutiveErrors,
                                strategy: '保持正常轮询间隔',
                                note: '网络问题通常是暂时的'
                            });
                        }
                        // 对于网络错误，不使用指数退避，继续正常轮询
                    } else {
                        // 非网络错误：使用原有的延迟策略
                        if (this.stats.consecutiveErrors > 3) {
                            const backoffDelay = Math.min(60000 * Math.pow(2, this.stats.consecutiveErrors - 3), 300000);
                            logger.warn(`${trader.label}连续非网络错误过多，暂停轮询${backoffDelay / 1000}秒`, {
                                consecutiveErrors: this.stats.consecutiveErrors,
                                backoffDelay: `${backoffDelay / 1000}s`
                            });
                            setTimeout(() => {
                                if (this.isRunning) {
                                    this.startTraderPolling(trader);
                                }
                            }, backoffDelay);
                            return;
                        }
                    }
                }
            }
        };

        // 添加随机延迟，分散API调用时间，避免所有交易员同时请求
        const randomDelay = Math.random() * 10000; // 0-10秒随机延迟
        logger.debug(`${trader.label}将在${(randomDelay / 1000).toFixed(1)}秒后开始轮询`, {
            randomDelay: `${(randomDelay / 1000).toFixed(1)}s`,
            reason: '分散API调用，避免429错误'
        });

        setTimeout(pollTrader, randomDelay);

        const interval = setInterval(pollTrader, this.POLLING_INTERVAL + Math.random() * 5000); // 轮询间隔也添加随机性
        this.pollingIntervals.push(interval);
    }

    private async pollTraderFills(trader: ContractTrader): Promise<void> {
        this.stats.totalRequests++;

        // 扩大时间窗口，并添加重叠检查避免遗漏
        const lastProcessed = this.lastProcessedTime.get(trader.address) || Date.now() - 60 * 60 * 1000;
        const startTime = lastProcessed - (5 * 60 * 1000); // 向前重叠5分钟，避免遗漏
        const endTime = Date.now();

        try {
            // 🔧 API速率限制检查 - 增强版
            const now = Date.now();
            const timeSinceLastCall = now - this.lastApiCall;
            if (timeSinceLastCall < this.API_RATE_LIMIT_MS) {
                const waitTime = this.API_RATE_LIMIT_MS - timeSinceLastCall;
                logger.debug(`⏰ ${trader.label} API速率限制等待 ${waitTime}ms`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
            this.lastApiCall = Date.now();
            logger.info(`🔍 轮询${trader.label}交易数据 (扩展窗口)`, {
                address: trader.address,
                startTime: new Date(startTime).toISOString(),
                endTime: new Date(endTime).toISOString(),
                timeRangeMinutes: Math.round((endTime - startTime) / (60 * 1000))
            });

            // 获取指定时间范围内的用户填充数据（带重试机制）
            const fills = await this.fetchFillsWithRetry(trader, startTime, endTime);

            // 详细记录API响应，检查是否达到返回限制
            const fillsCount = fills?.length || 0;
            logger.info(`📡 ${trader.label} API响应`, {
                address: trader.address,
                fillsCount: fillsCount,
                timeRangeMinutes: Math.round((endTime - startTime) / (60 * 1000)),
                possibleTruncation: fillsCount >= 2000 ? "⚠️ 可能被截断，API返回限制2000条" : "✅ 完整数据"
            });

            if (fills && fills.length > 0) {
                // 检查是否接近API限制
                if (fills.length >= 2000) {
                    logger.warn(`⚠️ ${trader.label} API返回达到限制`, {
                        fillsCount: fills.length,
                        message: "可能有更多交易未返回，建议缩短查询时间窗口"
                    });
                }

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

                // 🔍 关键修复：过滤历史订单
                const recentFills = this.filterHistoricalOrders(fills);

                if (recentFills.length === 0) {
                    logger.debug(`📋 ${trader.label} 过滤后无新交易`);
                    return;
                }

                // 按时间排序，确保按顺序处理
                recentFills.sort((a, b) => a.time - b.time);

                // 检测新订单并查询完整信息
                const newOrders = await this.detectAndFetchCompleteOrders(recentFills, trader);

                // 处理聚合后的订单（包括新检测到的完整订单）
                for (const aggregatedOrder of newOrders) {
                    await this.processAggregatedOrder(aggregatedOrder, trader);
                }

                this.stats.tradesProcessed += recentFills.length; // 使用过滤后的数量
                this.stats.totalAggregatedOrders += newOrders.length;
            } else {
                logger.debug(`💤 ${trader.label} 当前时间范围内无交易`);
            }

            // 更新最后处理时间
            this.lastProcessedTime.set(trader.address, endTime);

        } catch (error) {
            // 🔧 特殊处理429错误
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage.includes('429')) {
                this.stats.totalErrors++;
                this.stats.consecutiveErrors++;

                // 429错误需要更长的等待时间
                const backoffDelay = Math.min(30000 * Math.pow(2, this.stats.consecutiveErrors), 300000); // 30s, 60s, 120s, 240s, 最大5分钟
                logger.warn(`⚠️ ${trader.label} 触发API限制(429)，延长等待时间`, {
                    consecutiveErrors: this.stats.consecutiveErrors,
                    backoffDelay: `${backoffDelay / 1000}s`,
                    nextRetry: new Date(Date.now() + backoffDelay).toISOString(),
                    recommendation: '考虑增加轮询间隔'
                });

                // 更新最后处理时间，避免时间窗口过大
                this.lastProcessedTime.set(trader.address, endTime);
                throw new Error(`API_RATE_LIMITED_${backoffDelay}`);
            } else {
                logger.error(`${trader.label}数据获取失败:`, error);
                throw error;
            }
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

            // 检查是否启用交易分析
            const useTradingAnalysis = true; // 默认启用交易分析

            if (useTradingAnalysis) {
                // 使用交易分析系统，不发送基础事件以避免重复
                logger.debug(`📊 [调试] 使用交易分析处理 ${trader.label} 的填充，跳过基础事件发送`, {
                    trader: trader.label,
                    asset: coin,
                    size: size,
                    notional: `$${notionalValue.toFixed(2)}`,
                    eventPath: '跳过基础事件，等待交易分析'
                });
                return; // 让聚合订单处理逻辑来发送分析的事件
            } else {
                // 使用基础系统：直接发射事件，不聚合
                logger.info(`📊 [调试] 使用基础系统发送事件`, {
                    trader: trader.label,
                    asset: coin,
                    size: size,
                    notional: `$${notionalValue.toFixed(2)}`,
                    eventPath: '基础事件路径'
                });

                const signal = this.convertFillToContractSignal(fill, trader);
                if (signal) {
                    signal.metadata = {
                        ...signal.metadata,
                        source: 'pure-rpc-api',
                        enhanced: false
                    };

                    this.emit('contractEvent', signal, trader);
                    this.stats.totalEvents++;
                }
            }

        } catch (error) {
            logger.error(`处理${trader.label}填充失败:`, error, { fill });
        }
    }

    /**
     * 过滤历史订单，只处理系统启动后的交易
     */
    private filterHistoricalOrders(fills: any[]): any[] {
        const filteredFills = fills.filter(fill => {
            const fillTime = fill.time; // 已经是毫秒时间戳
            const isAfterStart = fillTime >= this.systemStartTime;

            if (!isAfterStart) {
                logger.debug(`⏭️ 跳过历史订单`, {
                    fillTime: new Date(fillTime).toISOString(),
                    systemStart: new Date(this.systemStartTime).toISOString(),
                    coin: fill.coin,
                    oid: fill.oid
                });
            }

            return isAfterStart;
        });

        if (filteredFills.length < fills.length) {
            logger.info(`🔍 历史订单过滤`, {
                totalFills: fills.length,
                filteredFills: filteredFills.length,
                skippedHistorical: fills.length - filteredFills.length,
                systemStartTime: new Date(this.systemStartTime).toISOString()
            });
        }

        return filteredFills;
    }

    /**
     * 按订单ID聚合填充，避免同一订单的多个子成交重复警报
     */
    private aggregateFillsByOrder(fills: any[], trader: ContractTrader): any[] {
        const orderMap = new Map<number, any[]>();
        let duplicateCount = 0;

        // 按oid分组，同时进行去重
        for (const fill of fills) {
            // 生成唯一标识符
            const fillId = fill.hash || fill.tid || `${fill.oid}_${fill.time}_${fill.sz}`;

            // 检查是否已经处理过
            if (this.processedFills.has(fillId)) {
                duplicateCount++;
                logger.debug(`⏭️ ${trader.label} 跳过重复填充`, {
                    fillId: fillId,
                    coin: fill.coin,
                    size: fill.sz,
                    time: new Date(fill.time).toISOString()
                });
                continue;
            }

            if (!this.validateFill(fill, trader)) {
                continue; // 跳过不符合条件的fill
            }

            // 标记为已处理
            this.processedFills.add(fillId);

            // 清理缓存，避免内存泄漏（改进：从10%提升到40%）
            if (this.processedFills.size > this.MAX_CACHE_SIZE) {
                const oldEntries = Array.from(this.processedFills).slice(0, 4000); // 40%
                oldEntries.forEach(entry => this.processedFills.delete(entry));
                logger.info(`🧹 ${trader.label} 清理去重缓存`, {
                    removed: oldEntries.length,
                    remaining: this.processedFills.size,
                    cleanupRate: '40%'
                });
            }

            const oid = fill.oid;
            if (!orderMap.has(oid)) {
                orderMap.set(oid, []);
            }
            orderMap.get(oid)!.push(fill);
        }

        if (duplicateCount > 0) {
            logger.info(`🔄 ${trader.label} 去重统计`, {
                totalFills: fills.length,
                duplicates: duplicateCount,
                uniqueFills: fills.length - duplicateCount,
                cacheSize: this.processedFills.size
            });
        }

        // 为每个订单创建聚合对象
        const aggregatedOrders: any[] = [];

        for (const [oid, orderFills] of orderMap.entries()) {
            if (orderFills.length === 0) continue;

            // 按时间排序
            orderFills.sort((a, b) => a.time - b.time);

            // 计算总量和平均价格
            const totalSize = orderFills.reduce((sum, fill) => sum + parseFloat(fill.sz), 0);
            const weightedPriceSum = orderFills.reduce((sum, fill) => sum + (parseFloat(fill.sz) * parseFloat(fill.px)), 0);
            const avgPrice = totalSize > 0 ? weightedPriceSum / totalSize : parseFloat(orderFills[0].px);

            const aggregated = {
                ...orderFills[0], // 使用第一个fill作为基础
                sz: totalSize.toString(), // 更新为总量
                px: avgPrice.toString(), // 更新为平均价格
                aggregatedFills: orderFills.length, // 聚合的fill数量
                firstFillTime: orderFills[0].time,
                lastFillTime: orderFills[orderFills.length - 1].time,
                totalNotional: totalSize * avgPrice,
                isAggregated: orderFills.length > 1
            };

            aggregatedOrders.push(aggregated);

            if (orderFills.length > 1) {
                logger.info(`📋 ${trader.label} 订单聚合`, {
                    oid: oid,
                    coin: aggregated.coin,
                    side: aggregated.side,
                    fillsCount: orderFills.length,
                    totalSize: totalSize,
                    avgPrice: avgPrice.toFixed(4),
                    timeSpan: `${new Date(aggregated.firstFillTime).toISOString()} - ${new Date(aggregated.lastFillTime).toISOString()}`
                });
            }
        }

        // 定期清理订单追踪缓存，防止内存泄漏
        this.cleanupTrackedOrders();

        return aggregatedOrders;
    }

    /**
     * 清理订单追踪缓存，防止内存泄漏
     */
    private cleanupTrackedOrders(): void {
        const TRACKED_ORDERS_LIMIT = 5000;
        const CLEANUP_COUNT = 2000; // 40%

        if (this.trackedOrders.size > TRACKED_ORDERS_LIMIT) {
            const ordersToRemove = Array.from(this.trackedOrders).slice(0, CLEANUP_COUNT);
            
            ordersToRemove.forEach(oid => {
                this.trackedOrders.delete(oid);
                this.orderCompletionCache.delete(oid); // 同时清理对应的订单缓存
            });

            logger.info('🧹 清理订单追踪缓存', {
                removed: ordersToRemove.length,
                remainingOrders: this.trackedOrders.size,
                remainingCache: this.orderCompletionCache.size,
                cleanupRate: '40%'
            });
        }
    }

    /**
     * 处理聚合后的订单 (增强版)
     */
    private async processAggregatedOrder(aggregatedOrder: any, trader: ContractTrader): Promise<void> {
        try {
            const coin = aggregatedOrder.coin;
            const size = parseFloat(aggregatedOrder.sz || '0');
            const price = parseFloat(aggregatedOrder.px || '0');
            const notionalValue = Math.abs(size) * price;

            // 检查最小名义价值阈值
            if (notionalValue < this.minNotionalValue) {
                logger.debug(`${trader.label}聚合订单名义价值${notionalValue}低于阈值${this.minNotionalValue}，跳过`);
                return;
            }

            logger.info(`🎯 ${trader.label} 检测到交易${aggregatedOrder.isAggregated ? '(聚合)' : ''}`, {
                coin: coin,
                side: aggregatedOrder.side,
                size: size,
                price: `$${price}`,
                notional: `$${notionalValue.toFixed(2)}`,
                aggregatedFills: aggregatedOrder.aggregatedFills,
                oid: aggregatedOrder.oid
            });

            // 使用交易分类引擎处理交易
            const analyzedEvent = await this.classificationEngine.classifyTrade(
                aggregatedOrder,
                trader,
                8000,  // 8秒初始延迟等待交易结算
                2      // 最多重试2次
            );

            if (analyzedEvent) {
                logger.info(`🏷️ ${trader.label} 交易分类完成`, {
                    asset: analyzedEvent.asset,
                    type: analyzedEvent.classification?.type,
                    description: analyzedEvent.classification?.description,
                    confidence: analyzedEvent.classification?.confidence,
                    positionChange: analyzedEvent.positionChange
                });

                // 🆕 alertProfile 路由：whale-watch 走干净字段模板，其余保持 TradingAnalysisSystem
                let alertToSend: ContractWebhookAlert | null;
                const isWhaleWatch = trader.alertProfile === 'whale-watch' && !!this.whaleFormatter;

                if (isWhaleWatch) {
                    alertToSend = await this.whaleFormatter!.formatContractEvent(analyzedEvent, trader);
                    if (!alertToSend) {
                        // 鲸鱼 formatter 只处理开仓/平仓，其他事件类型返回 null → 不发送
                        logger.debug(`🐋 [whale-watch] 事件类型不在鲸鱼监控范围，跳过`, {
                            trader: trader.label,
                            asset: analyzedEvent.asset,
                            eventType: analyzedEvent.eventType
                        });
                        return;
                    }
                } else {
                    alertToSend = await this.alertSystem.createTradingAlert(analyzedEvent, trader);
                }

                logger.info(`🚨 [调试] 即将发送合约告警`, {
                    trader: trader.label,
                    profile: trader.alertProfile || 'trading-analysis',
                    asset: analyzedEvent.asset,
                    alertType: alertToSend.alertType,
                    route: isWhaleWatch ? 'whale-watch' : 'trading-analysis'
                });

                // 发射合约告警事件（上层根据 profile 路由 webhook URL）
                this.emit('contractEvent', alertToSend, trader);
                this.stats.totalEvents++;
            } else {
                logger.warn(`⚠️ [调试] 交易分类失败，事件被跳过`, {
                    trader: trader.label,
                    asset: aggregatedOrder.coin,
                    size: aggregatedOrder.sz,
                    notional: `$${(Math.abs(parseFloat(aggregatedOrder.sz || '0')) * parseFloat(aggregatedOrder.px || '0')).toFixed(2)}`,
                    reason: '增强分析返回null',
                    eventPath: '分析失败，无事件发送'
                });
            }

        } catch (error) {
            logger.error(`处理${trader.label}聚合订单失败:`, error, { order: aggregatedOrder });
        }
    }

    /**
     * 检测新订单并获取完整的订单信息（优化版，避免429错误）
     */
    private async detectAndFetchCompleteOrders(fills: any[], trader: ContractTrader): Promise<any[]> {
        const completeOrders: any[] = [];
        const newOrderIds: number[] = [];

        // 收集所有新的订单ID
        for (const fill of fills) {
            if (!this.validateFill(fill, trader)) {
                continue;
            }

            const oid = fill.oid;
            if (!this.trackedOrders.has(oid) && !this.pendingOrderQueries.has(oid)) {
                newOrderIds.push(oid);
                this.trackedOrders.add(oid);
            }
        }

        if (newOrderIds.length === 0) {
            return completeOrders;
        }

        logger.info(`🔍 检测到${newOrderIds.length}个新订单`, {
            trader: trader.label,
            orderIds: newOrderIds.slice(0, 3), // 只显示前3个
            totalCount: newOrderIds.length
        });

        // 限制并发查询数量，避免速率限制
        const MAX_CONCURRENT = 2;
        const chunks = [];
        for (let i = 0; i < newOrderIds.length; i += MAX_CONCURRENT) {
            chunks.push(newOrderIds.slice(i, i + MAX_CONCURRENT));
        }

        // 分批处理订单查询
        for (const chunk of chunks) {
            const promises = chunk.map(oid => this.fetchCompleteOrderWithRateLimit(oid, trader));
            const results = await Promise.allSettled(promises);

            for (let i = 0; i < results.length; i++) {
                const result = results[i];
                const oid = chunk[i];

                if (result.status === 'fulfilled' && result.value) {
                    completeOrders.push(result.value);
                    this.orderCompletionCache.set(oid, result.value);
                } else if (result.status === 'rejected') {
                    logger.warn(`⚠️ 订单${oid}查询失败，将稍后重试`, {
                        trader: trader.label,
                        error: result.reason instanceof Error ? result.reason.message : result.reason
                    });
                    // 从追踪列表中移除，允许下次重试
                    this.trackedOrders.delete(oid);
                }
            }

            // 在批次之间添加延迟
            if (chunks.indexOf(chunk) < chunks.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        if (completeOrders.length > 0) {
            logger.info(`✅ ${trader.label} 成功获取${completeOrders.length}个完整订单`, {
                successCount: completeOrders.length,
                totalRequested: newOrderIds.length
            });
        }

        return completeOrders;
    }

    /**
     * 带速率限制的订单查询
     */
    private async fetchCompleteOrderWithRateLimit(oid: number, trader: ContractTrader): Promise<any | null> {
        // 检查是否已有查询在进行
        if (this.pendingOrderQueries.has(oid)) {
            return await this.pendingOrderQueries.get(oid);
        }

        // 速率限制检查
        const now = Date.now();
        const timeSinceLastCall = now - this.lastApiCall;
        if (timeSinceLastCall < this.API_RATE_LIMIT_MS) {
            const waitTime = this.API_RATE_LIMIT_MS - timeSinceLastCall;
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }

        // 创建查询Promise并缓存
        const queryPromise = this.fetchCompleteOrderByOid(oid, trader);
        this.pendingOrderQueries.set(oid, queryPromise);

        try {
            this.lastApiCall = Date.now();
            const result = await queryPromise;
            return result;
        } finally {
            // 清理pending查询
            this.pendingOrderQueries.delete(oid);
        }
    }

    /**
     * 根据 OID 获取完整的订单信息（优化版）
     */
    private async fetchCompleteOrderByOid(oid: number, trader: ContractTrader): Promise<any | null> {
        try {
            // 使用更精确的时间范围，减少API负载
            const endTime = Date.now();
            const startTime = endTime - (6 * 60 * 60 * 1000); // 缩短到6小时，减少API压力

            logger.debug(`🔎 查询订单${oid}的所有成交`, {
                trader: trader.label,
                oid: oid,
                timeRange: '过去6小时'
            });

            // 使用聚合模式减少返回数据量
            const allFills = await this.infoClient.userFillsByTime({
                user: trader.address as `0x${string}`,
                startTime: startTime,
                endTime: endTime,
                aggregateByTime: true // 使用聚合，减少数据量
            });

            if (!allFills || allFills.length === 0) {
                logger.debug(`📭 未找到订单${oid}的成交记录`, {
                    trader: trader.label
                });
                return null;
            }

            // 筛选出属于该订单的填充
            const orderFills = allFills.filter(fill =>
                fill.oid === oid &&
                this.validateFill(fill, trader)
            );

            if (orderFills.length === 0) {
                logger.debug(`📭 订单${oid}没有有效的成交记录`, {
                    trader: trader.label,
                    totalFills: allFills.length
                });
                return null;
            }

            // 创建完整订单对象
            const completeOrder = this.createCompleteOrderFromFills(orderFills, oid, trader);
            return completeOrder;

        } catch (error) {
            // 特殊处理429错误
            if (error instanceof Error && error.message.includes('429')) {
                logger.warn(`⏰ API速率限制，订单${oid}将延后查询`, {
                    trader: trader.label
                });
                throw new Error('RATE_LIMITED');
            }

            logger.error(`获取订单${oid}完整信息时出错`, {
                trader: trader.label,
                error: error instanceof Error ? error.message : error
            });
            throw error;
        }
    }

    /**
     * 从填充数组创建完整订单对象
     */
    private createCompleteOrderFromFills(orderFills: any[], oid: number, trader: ContractTrader): any {
        // 按时间排序
        orderFills.sort((a, b) => a.time - b.time);

        // 计算订单总量和加权平均价格
        const totalSize = orderFills.reduce((sum, fill) => sum + parseFloat(fill.sz), 0);
        const weightedPriceSum = orderFills.reduce((sum, fill) =>
            sum + (parseFloat(fill.sz) * parseFloat(fill.px)), 0);
        const avgPrice = totalSize > 0 ? weightedPriceSum / totalSize : parseFloat(orderFills[0].px);

        const completeOrder = {
            ...orderFills[0], // 使用第一个fill作为基础
            sz: totalSize.toString(), // 更新为总量
            px: avgPrice.toString(), // 更新为加权平均价格
            aggregatedFills: orderFills.length, // 聚合的fill数量
            firstFillTime: orderFills[0].time,
            lastFillTime: orderFills[orderFills.length - 1].time,
            totalNotional: totalSize * avgPrice,
            isAggregated: orderFills.length > 1,
            isCompleteOrder: true, // 标记为完整订单
            fillsSpan: orderFills.length > 1 ?
                `${new Date(orderFills[0].time).toISOString()} - ${new Date(orderFills[orderFills.length - 1].time).toISOString()}` :
                new Date(orderFills[0].time).toISOString()
        };

        logger.info(`📊 ${trader.label} 订单${oid}完整统计`, {
            coin: completeOrder.coin,
            side: completeOrder.side,
            totalSize: totalSize,
            avgPrice: avgPrice.toFixed(6),
            fillsCount: orderFills.length,
            totalNotional: `$${(totalSize * avgPrice).toFixed(2)}`,
            crossed: completeOrder.crossed
        });

        return completeOrder;
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

        // 详细记录fill数据，用于调试
        logger.info(`🔍 ${trader.label} 填充数据检查`, {
            coin: fill.coin,
            side: fill.side,
            size: fill.sz,
            price: fill.px,
            hash: fill.hash,
            oid: fill.oid,
            crossed: fill.crossed,
            fillUser: (fill as any).user,
            traderAddress: trader.address,
            time: new Date(fill.time).toISOString()
        });

        // 验证用户地址匹配（关键检查）
        if ((fill as any).user && (fill as any).user.toLowerCase() !== trader.address.toLowerCase()) {
            logger.warn(`❌ ${trader.label}地址不匹配，跳过`, {
                fillUser: (fill as any).user,
                traderAddress: trader.address,
                hash: fill.hash,
                coin: fill.coin
            });
            return false;
        }

        // 跳过现货交易（以@开头的资产）
        if (fill.coin.startsWith('@')) {
            logger.debug(`${trader.label}跳过现货交易: ${fill.coin}`);
            return false;
        }

        // 移除crossed过滤，监控所有重要交易（挂单和吃单）
        logger.debug(`${trader.label}接受交易: ${fill.coin} ${fill.side} ${fill.sz}`, {
            crossed: fill.crossed,
            oid: fill.oid,
            type: fill.crossed ? '吃单' : '挂单'
        });

        return true;
    }

    /**
     * @deprecated 使用 TradeClassificationEngine.classifyTrade 替代
     * 将填充转换为合约信号 (保留用于后备场景)
     */
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
                address: (fill as any).user || trader.address, // 优先使用fill中的实际用户地址
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
                    traderLabel: trader.label,
                    monitoredAddress: trader.address, // 记录监控的地址
                    actualFillUser: (fill as any).user, // 记录实际成交用户
                    oid: fill.oid,
                    crossed: fill.crossed,
                    source: 'pure-rpc-api',
                    isRealTime: false,
                    fillType: fill.side,
                    originalFill: fill
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

            logger.info('📊 纯净RPC合约监控状态报告 (增强版)', {
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
                    Math.round(((this.stats.totalRequests - this.stats.totalErrors) / this.stats.totalRequests) * 100) + '%' : 'N/A',

                // 增强功能统计
                positionManager: this.positionManager.getStats(),
                classificationEngine: this.classificationEngine.getStats(),
                analysisEngine: this.analysisEngine.getStats(),
                alertSystem: this.alertSystem.getStats()
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
            strategy: 'pure-rpc-official-api-enhanced-v2',
            traders: this.traders.length,
            startTime: this.startTime,
            uptime: this.isRunning ? Date.now() - this.startTime : 0,
            pollingInterval: this.POLLING_INTERVAL,
            stats: this.stats,
            successRate: this.stats.totalRequests > 0 ?
                Math.round(((this.stats.totalRequests - this.stats.totalErrors) / this.stats.totalRequests) * 100) : 0,

            // 增强功能统计
            enhancedFeatures: {
                positionManager: this.positionManager.getStats(),
                classificationEngine: this.classificationEngine.getStats(),
                analysisEngine: this.analysisEngine.getStats(),
                alertSystem: this.alertSystem.getStats()
            }
        };
    }

    getStatus() {
        const timeSinceLastPoll = Date.now() - this.stats.lastSuccessfulPoll;

        return {
            isRunning: this.isRunning,
            monitoringMode: 'pure-rpc-enhanced',
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
            })),

            // 增强功能状态
            enhancedFeatures: {
                positionManagerEnabled: true,
                classificationEngineEnabled: true,
                analysisEngineEnabled: true,
                alertSystemEnabled: true,
                positionCacheSize: this.positionManager.getStats().cacheSize,
                classificationTotal: this.classificationEngine.getStats().totalClassifications,
                totalAnalysis: this.analysisEngine.getStats().totalAnalysis,
                advancedAlertRate: this.alertSystem.getStats().advancedRate + '%'
            }
        };
    }

    getTotalSubscriptions(): number {
        return this.traders.length;
    }

    /**
     * 检测是否为网络错误
     */
    private isNetworkError(error: unknown): boolean {
        if (!error || typeof error !== 'object') return false;

        const errorMessage = error instanceof Error ? error.message : String(error);
        const cause = (error as any).cause;

        // 检查常见的网络错误标识
        const networkErrorPatterns = [
            'fetch failed',
            'EAI_AGAIN',
            'ENOTFOUND',
            'ECONNREFUSED',
            'ECONNRESET',
            'ETIMEDOUT',
            'EHOSTUNREACH',
            'getaddrinfo',
            'network error',
            'DNS error'
        ];

        // 检查错误消息
        const hasNetworkPattern = networkErrorPatterns.some(pattern =>
            errorMessage.toLowerCase().includes(pattern.toLowerCase())
        );

        // 检查 cause 对象中的网络错误
        if (cause && typeof cause === 'object') {
            const causeCode = (cause as any).code;
            const causeSyscall = (cause as any).syscall;

            if (causeCode === 'EAI_AGAIN' ||
                causeCode === 'ENOTFOUND' ||
                causeCode === 'ECONNREFUSED' ||
                causeCode === 'ECONNRESET' ||
                causeCode === 'ETIMEDOUT' ||
                causeSyscall === 'getaddrinfo') {
                return true;
            }
        }

        return hasNetworkPattern;
    }

    /**
     * 带重试机制的API调用
     */
    private async fetchFillsWithRetry(trader: ContractTrader, startTime: number, endTime: number, maxRetries: number = 3): Promise<any[]> {
        let lastError: unknown;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const fills = await this.infoClient.userFillsByTime({
                    user: trader.address as `0x${string}`,
                    startTime: startTime,
                    endTime: endTime,
                    aggregateByTime: true
                });

                // 成功获取数据，重置错误计数
                if (attempt > 1) {
                    logger.info(`✅ ${trader.label} API重试成功`, {
                        attempt,
                        maxRetries
                    });
                }

                return fills || [];

            } catch (error) {
                lastError = error;
                const isNetworkError = this.isNetworkError(error);

                logger.warn(`⚠️ ${trader.label} API调用失败 (尝试 ${attempt}/${maxRetries})`, {
                    error: error instanceof Error ? error.message : error,
                    isNetworkError,
                    willRetry: attempt < maxRetries
                });

                // 如果是网络错误且还有重试机会，等待后重试
                if (isNetworkError && attempt < maxRetries) {
                    const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000); // 1s, 2s, 4s, 最大5s
                    logger.debug(`⏰ 等待${delayMs}ms后重试...`);
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                    continue;
                }

                // 非网络错误或者达到最大重试次数，直接抛出
                if (!isNetworkError || attempt >= maxRetries) {
                    throw error;
                }
            }
        }

        // 理论上不会到达这里，但为了类型安全
        throw lastError;
    }
}

export default PureRpcContractMonitor;