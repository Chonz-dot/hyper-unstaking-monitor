
import { EventEmitter } from 'events';
import { ContractTrader, ContractEvent, ContractWebhookAlert } from '../types';
import logger from '../logger';
import config from '../config';
import * as hl from '@nktkas/hyperliquid';
import WebSocket from 'ws';

// Node.js WebSocket polyfill
if (typeof globalThis.WebSocket === 'undefined') {
    globalThis.WebSocket = WebSocket as any;
}

/**
 * 稳健的WebSocket合约监控器
 * 采用保守策略：单连接 + 简化重连 + 更长超时
 * 优先稳定性而非并发性能
 */
export class RobustWebSocketContractMonitor extends EventEmitter {
    private traders: ContractTrader[];
    private minNotionalValue: number;
    private isRunning = false;
    private startTime: number;
    private consecutiveErrors = 0;
    private maxConsecutiveErrors: number;

    // 简化的单连接架构
    private transport: hl.WebSocketTransport | null = null;
    private client: hl.SubscriptionClient | null = null;
    private subscriptions = new Map<string, any>();
    private connectionHealth = {
        lastPingTime: 0,
        consecutiveFailures: 0,
        totalReconnects: 0,
        lastSuccessfulMessage: 0,
        isActive: false,
        lastConnectionTime: 0,
        connectionAttempts: 0
    };

    // 订单聚合管理
    private pendingOrderFills = new Map<string, {
        oid: number;
        trader: ContractTrader;
        fills: any[];
        totalSize: number;
        avgPrice: number;
        firstFill: any;
        lastUpdate: number;
    }>();
    private readonly ORDER_COMPLETION_DELAY = 3000;

    // 稳定性配置
    private readonly CONNECTION_TIMEOUT = 180000; // 3分钟连接超时
    private readonly SUBSCRIPTION_TIMEOUT = 300000; // 5分钟订阅超时
    private readonly SUBSCRIPTION_INTERVAL = 20000; // 20秒订阅间隔
    private readonly MAX_SUBSCRIPTION_RETRIES = 5; // 最大重试次数
    private readonly HEALTH_CHECK_INTERVAL = 60000; // 1分钟健康检查

    constructor(traders: ContractTrader[], minNotionalValue = 10) {
        super();
        this.traders = traders.filter(t => t.isActive);
        this.minNotionalValue = minNotionalValue;
        this.startTime = Date.now();
        this.maxConsecutiveErrors = config.hyperliquid.maxConsecutiveErrors;

        logger.info('🔄 初始化稳健WebSocket合约监控器', {
            activeTraders: this.traders.length,
            minNotionalValue,
            strategy: '单连接 + 保守重连 + 长超时',
            connectionTimeout: `${this.CONNECTION_TIMEOUT / 1000}s`,
            subscriptionTimeout: `${this.SUBSCRIPTION_TIMEOUT / 1000}s`,
            subscriptionInterval: `${this.SUBSCRIPTION_INTERVAL / 1000}s`
        });
    }

    async start(): Promise<void> {
        if (this.isRunning) {
            logger.warn('稳健WebSocket合约监控器已在运行');
            return;
        }

        logger.info('🚀 启动稳健WebSocket合约监控器');
        this.isRunning = true;
        this.consecutiveErrors = 0;

        try {
            await this.createRobustConnection();
            await this.subscribeAllTradersRobustly();

            const totalSubscriptions = this.subscriptions.size;
            const actualSuccessRate = this.traders.length > 0 ?
                Math.round((totalSubscriptions / this.traders.length) * 100) : 0;

            logger.info('✅ 稳健WebSocket合约监控器启动成功', {
                activeTraders: this.traders.length,
                successfulSubscriptions: totalSubscriptions,
                actualSuccessRate: `${actualSuccessRate}%`,
                strategy: 'single-connection-robust'
            });

            this.startRobustHealthMonitoring();

        } catch (error) {
            logger.error('稳健WebSocket合约监控器启动失败:', error);
            this.isRunning = false;
            throw error;
        }
    }

    private async createRobustConnection(): Promise<void> {
        logger.info('🔗 创建稳健WebSocket连接...');

        try {
            this.connectionHealth.connectionAttempts++;
            this.connectionHealth.lastConnectionTime = Date.now();

            this.transport = new hl.WebSocketTransport({
                url: config.hyperliquid.wsUrl,
                timeout: this.CONNECTION_TIMEOUT, // 3分钟超时
                keepAlive: {
                    interval: 45000, // 45秒心跳
                    timeout: 30000   // 30秒心跳超时
                },
                reconnect: {
                    maxRetries: 3, // 保守的重试次数
                    connectionTimeout: this.CONNECTION_TIMEOUT,
                    connectionDelay: (attempt: number) => {
                        // 非常保守的退避：30s, 60s, 120s
                        return Math.min(30000 * attempt, 120000);
                    },
                    shouldReconnect: (error: any) => {
                        const errorMessage = error?.message?.toLowerCase() || '';

                        logger.warn('📡 连接断开，评估是否重连', {
                            error: errorMessage,
                            connectionAttempts: this.connectionHealth.connectionAttempts,
                            consecutiveErrors: this.consecutiveErrors
                        });

                        // 认证错误不重连
                        if (errorMessage.includes('unauthorized') || errorMessage.includes('forbidden')) {
                            logger.error('认证错误，停止重连', { error: errorMessage });
                            return false;
                        }

                        // 连续错误过多不重连
                        if (this.consecutiveErrors > this.maxConsecutiveErrors) {
                            logger.error('连续错误过多，停止重连', {
                                consecutiveErrors: this.consecutiveErrors
                            });
                            return false;
                        }

                        // 连接尝试过多，暂停重连
                        if (this.connectionHealth.connectionAttempts > 20) {
                            logger.error('连接尝试过多，暂停重连', {
                                connectionAttempts: this.connectionHealth.connectionAttempts
                            });
                            return false;
                        }

                        this.connectionHealth.totalReconnects++;
                        logger.info('🔄 准备重连', {
                            reconnectCount: this.connectionHealth.totalReconnects
                        });

                        return true;
                    }
                },
                autoResubscribe: false // 关闭自动重订阅，手动控制
            });

            this.client = new hl.SubscriptionClient({ transport: this.transport });

            // 等待连接真正就绪
            await this.waitForRobustConnection();

            // 额外的连接稳定性检查
            await this.verifyConnectionStability();

            this.connectionHealth = {
                ...this.connectionHealth,
                lastPingTime: Date.now(),
                consecutiveFailures: 0,
                lastSuccessfulMessage: Date.now(),
                isActive: true
            };

            logger.info('✅ 稳健WebSocket连接建立成功');

        } catch (error) {
            logger.error('❌ 稳健WebSocket连接建立失败:', error);
            this.connectionHealth.isActive = false;
            throw error;
        }
    }

    private async waitForRobustConnection(): Promise<void> {
        if (!this.transport) {
            throw new Error('Transport未初始化');
        }

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`WebSocket连接超时 (${this.CONNECTION_TIMEOUT / 1000}秒)`));
            }, this.CONNECTION_TIMEOUT);

            this.transport!.ready()
                .then(() => {
                    clearTimeout(timeout);
                    logger.info('✅ WebSocket transport就绪');
                    resolve();
                })
                .catch((error) => {
                    clearTimeout(timeout);
                    logger.error('❌ WebSocket transport连接失败:', error);
                    reject(error);
                });
        });
    }

    private async verifyConnectionStability(): Promise<void> {
        // 额外等待3秒确保连接稳定
        logger.info('🔍 验证连接稳定性...');
        await new Promise(resolve => setTimeout(resolve, 3000));

        if (!this.transport) {
            throw new Error('连接验证失败：transport不存在');
        }

        try {
            await this.transport.ready();
            logger.info('✅ 连接稳定性验证通过');
        } catch (error) {
            logger.error('❌ 连接稳定性验证失败:', error);
            throw new Error('连接不稳定，重新建立连接');
        }
    }

    private async subscribeAllTradersRobustly(): Promise<void> {
        if (!this.client) {
            throw new Error('Client未初始化');
        }

        logger.info('📋 开始稳健订阅所有交易员...');

        let totalSuccessful = 0;
        let totalFailed = 0;

        for (let i = 0; i < this.traders.length; i++) {
            const trader = this.traders[i];
            let subscribed = false;
            let attempt = 0;

            logger.info(`📡 开始订阅${trader.label} (${i + 1}/${this.traders.length})...`);

            while (!subscribed && attempt < this.MAX_SUBSCRIPTION_RETRIES) {
                try {
                    attempt++;
                    logger.info(`📡 订阅${trader.label} (尝试 ${attempt}/${this.MAX_SUBSCRIPTION_RETRIES})...`);

                    // 在每次订阅前检查连接状态
                    await this.ensureConnectionReady();

                    const subscription = await this.subscribeTraderRobustly(trader);
                    this.subscriptions.set(trader.address, subscription);

                    totalSuccessful++;
                    subscribed = true;

                    logger.info(`✅ ${trader.label} 订阅成功`);

                    // 订阅间隔 - 避免API压力
                    if (i < this.traders.length - 1) {
                        logger.info(`⏳ 等待${this.SUBSCRIPTION_INTERVAL / 1000}秒后订阅下一个交易员...`);
                        await new Promise(resolve => setTimeout(resolve, this.SUBSCRIPTION_INTERVAL));
                    }

                } catch (error) {
                    logger.error(`❌ ${trader.label}订阅失败 (尝试 ${attempt}/${this.MAX_SUBSCRIPTION_RETRIES}):`, error);

                    if (attempt < this.MAX_SUBSCRIPTION_RETRIES) {
                        const retryDelay = 30000 * attempt; // 30s, 60s, 90s, 120s, 150s
                        logger.info(`⏳ ${retryDelay / 1000}秒后重试${trader.label}...`);
                        await new Promise(resolve => setTimeout(resolve, retryDelay));
                    } else {
                        totalFailed++;
                        logger.error(`💥 ${trader.label} 最终订阅失败`);
                    }
                }
            }
        }

        const successRate = this.traders.length > 0 ? Math.round((totalSuccessful / this.traders.length) * 100) : 0;
        logger.info('📊 稳健订阅完成', {
            totalTraders: this.traders.length,
            successful: totalSuccessful,
            failed: totalFailed,
            successRate: `${successRate}%`
        });

        if (successRate < 50) {
            logger.warn(`⚠️ 订阅成功率较低 (${successRate}%)，可能需要调整策略`);
        }
    }

    private async ensureConnectionReady(): Promise<void> {
        if (!this.transport || !this.client) {
            throw new Error('连接组件未初始化');
        }

        try {
            await this.transport.ready();
            logger.debug('🔍 连接状态检查通过');
        } catch (error) {
            logger.error('❌ 连接状态检查失败:', error);
            throw new Error('连接不可用，需要重新建立连接');
        }
    }

    private async subscribeTraderRobustly(trader: ContractTrader): Promise<any> {
        if (!this.client) {
            throw new Error('Client未初始化');
        }

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`${trader.label}订阅超时 (${this.SUBSCRIPTION_TIMEOUT / 1000}秒)`));
            }, this.SUBSCRIPTION_TIMEOUT);

            logger.debug(`🌐 开始订阅${trader.label} userEvents...`);

            this.client!.userEvents(
                { user: trader.address as `0x${string}` },
                (data: any) => {
                    this.handleUserEventRobustly(data, trader);
                }
            )
                .then((subscription: any) => {
                    clearTimeout(timeout);
                    logger.debug(`📋 ${trader.label} userEvents订阅Promise完成`);
                    resolve(subscription);
                })
                .catch((error: any) => {
                    clearTimeout(timeout);
                    logger.error(`💥 ${trader.label} userEvents订阅Promise拒绝:`, {
                        error: error instanceof Error ? error.message : String(error),
                        errorType: error?.constructor?.name
                    });
                    reject(error);
                });
        });
    }

    private handleUserEventRobustly(data: any, trader: ContractTrader): void {
        try {
            // 验证事件地址匹配
            const actualUserAddress = this.extractUserAddressFromEvent(data);
            if (actualUserAddress && actualUserAddress.toLowerCase() !== trader.address.toLowerCase()) {
                return; // 地址不匹配，跳过
            }

            // 更新连接健康状态
            this.connectionHealth.lastSuccessfulMessage = Date.now();
            this.connectionHealth.consecutiveFailures = 0;
            this.connectionHealth.isActive = true;

            logger.debug(`📨 收到${trader.label}事件`, {
                eventKeys: Object.keys(data || {}),
                verifiedAddress: actualUserAddress
            });

            // 处理不同类型的事件
            if (data.delta?.type === 'perpetualPosition') {
                this.processDeltaEvent(data, trader);
            } else if (data.fills && Array.isArray(data.fills)) {
                this.processFillsEvent(data, trader);
            }

        } catch (error) {
            logger.error(`处理${trader.label}事件失败:`, error);
            this.consecutiveErrors++;
            this.connectionHealth.consecutiveFailures++;
        }
    }

    private extractUserAddressFromEvent(data: any): string | null {
        if (data.fills?.length > 0) {
            return data.fills[0].user || null;
        }

        if (data.delta?.perpetualPosition) {
            return data.delta.perpetualPosition.user || null;
        }

        return data.user || null;
    }

    private processFillsEvent(data: any, trader: ContractTrader): void {
        if (!data.fills || !Array.isArray(data.fills)) {
            return;
        }

        for (const fill of data.fills) {
            const coin = fill.coin;
            if (!coin || typeof coin !== 'string') {
                continue;
            }

            // 跳过现货交易
            if (coin.startsWith('@')) {
                continue;
            }

            const size = parseFloat(fill.sz || '0');
            const price = parseFloat(fill.px || '0');
            const notionalValue = Math.abs(size) * price;

            if (notionalValue < this.minNotionalValue) {
                continue;
            }

            // 订单聚合处理
            if (fill.oid) {
                this.handleOrderAggregation(fill, trader);
            } else {
                this.processSingleFill(fill, trader);
            }
        }
    }

    private processDeltaEvent(data: any, trader: ContractTrader): void {
        const signal = this.convertToContractSignal(data, trader);
        if (signal) {
            this.emit('contractEvent', signal, trader);
        }
    }

    // 订单聚合处理逻辑（保持原有逻辑）
    private handleOrderAggregation(fill: any, trader: ContractTrader): void {
        const oid = fill.oid;
        const key = `${trader.address}-${oid}`;

        if (!this.pendingOrderFills.has(key)) {
            this.pendingOrderFills.set(key, {
                oid: oid,
                trader: trader,
                fills: [fill],
                totalSize: Math.abs(parseFloat(fill.sz)),
                avgPrice: parseFloat(fill.px),
                firstFill: fill,
                lastUpdate: Date.now()
            });
        } else {
            const pending = this.pendingOrderFills.get(key)!;
            pending.fills.push(fill);

            const newSize = Math.abs(parseFloat(fill.sz));
            const newPrice = parseFloat(fill.px);
            pending.avgPrice = (pending.avgPrice * pending.totalSize + newPrice * newSize) / (pending.totalSize + newSize);
            pending.totalSize += newSize;
            pending.lastUpdate = Date.now();
        }

        setTimeout(() => {
            this.checkCompletedOrder(key, trader);
        }, this.ORDER_COMPLETION_DELAY);
    }

    private checkCompletedOrder(key: string, trader: ContractTrader): void {
        const pending = this.pendingOrderFills.get(key);
        if (!pending) return;

        const now = Date.now();
        if (now - pending.lastUpdate >= this.ORDER_COMPLETION_DELAY) {
            this.emitAggregatedOrder(pending);
            this.pendingOrderFills.delete(key);
        }
    }

    private emitAggregatedOrder(aggregatedOrder: any): void {
        const fill = aggregatedOrder.firstFill;
        const trader = aggregatedOrder.trader;

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
                aggregationTimespan: Date.now() - aggregatedOrder.fills[0].time
            };

            this.emit('contractEvent', signal, trader);
        }
    }

    private processSingleFill(fill: any, trader: ContractTrader): void {
        const signal = this.convertFillToContractSignal(fill, trader);
        if (signal) {
            this.emit('contractEvent', signal, trader);
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
                hash: fill.hash || fill.tid || `fill_${Date.now()}_${coin}`,
                blockTime: blockTime,
                metadata: {
                    notionalValue: notionalValue.toString(),
                    originalAsset: coin,
                    source: 'websocket-fills-robust',
                    isRealTime: true,
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

    private convertToContractSignal(event: any, trader: ContractTrader): ContractEvent | null {
        try {
            if (!event.delta || event.delta.type !== 'perpetualPosition') {
                return null;
            }

            const positionData = event.delta.perpetualPosition;
            if (!positionData?.position) {
                return null;
            }

            const coin = positionData.coin;
            const currentSize = parseFloat(positionData.position.szi || '0');
            const markPrice = parseFloat(positionData.markPrice || '0');

            if (coin.startsWith('@')) {
                return null;
            }

            const notionalValue = Math.abs(currentSize) * markPrice;
            if (notionalValue < this.minNotionalValue) {
                return null;
            }

            let eventType: 'position_open_long' | 'position_open_short' | 'position_close';
            let side: 'long' | 'short';

            if (Math.abs(currentSize) < 0.0001) {
                eventType = 'position_close';
                side = 'long';
            } else if (currentSize > 0) {
                eventType = 'position_open_long';
                side = 'long';
            } else {
                eventType = 'position_open_short';
                side = 'short';
            }

            let blockTime: number;
            if (event.time) {
                blockTime = event.time > 1e12 ? Math.floor(event.time / 1000) : Math.floor(event.time);
            } else {
                blockTime = Math.floor(Date.now() / 1000);
            }

            const result: ContractEvent = {
                timestamp: Date.now(),
                address: trader.address,
                eventType,
                asset: coin,
                size: Math.abs(currentSize).toString(),
                price: markPrice.toString(),
                side,
                hash: event.hash || `pos_${Date.now()}_${coin}`,
                blockTime: blockTime,
                positionSizeAfter: currentSize.toString(),
                metadata: {
                    notionalValue: notionalValue.toString(),
                    originalAsset: coin,
                    source: 'websocket-perpetualPosition-robust',
                    isRealTime: true,
                    markPrice: markPrice.toString(),
                    rawEventTime: event.time
                }
            };

            return result;

        } catch (error) {
            logger.error('转换合约信号失败:', error);
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

    private startRobustHealthMonitoring(): void {
        const statusInterval = setInterval(() => {
            if (!this.isRunning) {
                clearInterval(statusInterval);
                return;
            }

            const timeSinceLastMessage = Date.now() - this.connectionHealth.lastSuccessfulMessage;
            const isConnectionStale = timeSinceLastMessage > 300000; // 5分钟无消息认为有问题

            logger.info('📊 稳健合约监控状态报告', {
                uptime: Math.floor((Date.now() - this.startTime) / 1000) + 's',
                isActive: this.connectionHealth.isActive,
                totalTraders: this.traders.length,
                totalSubscriptions: this.subscriptions.size,
                consecutiveErrors: this.consecutiveErrors,
                totalReconnects: this.connectionHealth.totalReconnects,
                connectionAttempts: this.connectionHealth.connectionAttempts,
                lastMessageAge: Math.floor(timeSinceLastMessage / 1000) + 's',
                isStale: isConnectionStale,
                pendingOrders: this.pendingOrderFills.size
            });

            // 执行健康检查和自动修复
            this.performRobustHealthCheck();

        }, this.HEALTH_CHECK_INTERVAL);
    }

    private performRobustHealthCheck(): void {
        const now = Date.now();
        const timeSinceLastMessage = now - this.connectionHealth.lastSuccessfulMessage;
        const criticalThreshold = 600000; // 10分钟认为严重问题

        if (timeSinceLastMessage > criticalThreshold) {
            logger.error('🚨 连接长时间无响应，启动重建连接', {
                timeSinceLastMessage: Math.floor(timeSinceLastMessage / 1000) + 's',
                criticalThreshold: Math.floor(criticalThreshold / 1000) + 's'
            });

            this.reconnectRobustly().catch(error => {
                logger.error('❌ 稳健重连失败:', error);
            });
        }
    }

    private async reconnectRobustly(): Promise<void> {
        try {
            logger.info('🔄 开始稳健重连...');

            // 清理旧连接
            try {
                if (this.subscriptions.size > 0) {
                    for (const [address, subscription] of this.subscriptions) {
                        if (subscription?.unsubscribe) {
                            await subscription.unsubscribe();
                        }
                    }
                    this.subscriptions.clear();
                }

                if (this.transport) {
                    await this.transport.close();
                }
            } catch (error) {
                logger.debug('清理旧连接时出错:', error);
            }

            // 等待一段时间后重新建立连接
            logger.info('⏳ 等待30秒后重新建立连接...');
            await new Promise(resolve => setTimeout(resolve, 30000));

            // 重新建立连接
            await this.createRobustConnection();

            // 重新订阅
            await this.subscribeAllTradersRobustly();

            logger.info('✅ 稳健重连完成', {
                subscriptionsCount: this.subscriptions.size,
                totalReconnects: this.connectionHealth.totalReconnects
            });

        } catch (error) {
            logger.error('💥 稳健重连过程失败:', error);
            this.connectionHealth.isActive = false;
            this.connectionHealth.consecutiveFailures++;
        }
    }

    async stop(): Promise<void> {
        if (!this.isRunning) {
            return;
        }

        logger.info('⏹️ 停止稳健WebSocket合约监控器');
        this.isRunning = false;

        // 清理pending订单
        logger.info(`🧹 清理 ${this.pendingOrderFills.size} 个待聚合订单`);
        this.pendingOrderFills.clear();

        try {
            // 取消所有订阅
            for (const [address, subscription] of this.subscriptions) {
                if (subscription?.unsubscribe) {
                    await subscription.unsubscribe();
                }
            }
            this.subscriptions.clear();

            // 关闭连接
            if (this.transport) {
                await this.transport.close();
            }

            logger.info('✅ 稳健WebSocket合约监控器已停止');
        } catch (error) {
            logger.warn('⚠️ 停止过程中出现错误:', error);
        }
    }

    getTotalSubscriptions(): number {
        return this.subscriptions.size;
    }

    getStats() {
        return {
            isRunning: this.isRunning,
            strategy: 'robust-single-websocket',
            traders: this.traders.length,
            subscriptions: this.subscriptions.size,
            consecutiveErrors: this.consecutiveErrors,
            startTime: this.startTime,
            uptime: this.isRunning ? Date.now() - this.startTime : 0,
            connectionHealth: this.connectionHealth,
            successRate: this.traders.length > 0 ? Math.round((this.subscriptions.size / this.traders.length) * 100) : 0
        };
    }

    getStatus() {
        const timeSinceLastMessage = Date.now() - this.connectionHealth.lastSuccessfulMessage;

        return {
            isRunning: this.isRunning,
            connectionMode: 'robust-single-connection',
            isActive: this.connectionHealth.isActive,
            totalSubscriptions: this.subscriptions.size,
            totalTraders: this.traders.length,
            consecutiveErrors: this.consecutiveErrors,
            totalReconnects: this.connectionHealth.totalReconnects,
            connectionAttempts: this.connectionHealth.connectionAttempts,
            lastMessageAge: Math.floor(timeSinceLastMessage / 1000),
            uptime: this.isRunning ? Date.now() - this.startTime : 0,
            subscribers: Array.from(this.subscriptions.keys()).map(address => ({
                address: address.slice(0, 8) + '...',
                subscribed: true
            }))
        };
    }
}

export default RobustWebSocketContractMonitor;