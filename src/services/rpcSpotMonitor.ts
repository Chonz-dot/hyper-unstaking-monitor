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

    // 轮询配置 - 优化API调用频率
    private readonly POLLING_INTERVAL = 120000; // 增加到60秒轮询间隔，减少API压力
    private readonly ERROR_RETRY_DELAY = 300000; // 错误重试延迟120秒

    // 追踪已处理的转账，避免重复
    private lastProcessedTime = new Map<string, number>();
    private processedTransfers = new Set<string>(); // 使用hash避免重复
    private readonly MAX_CACHE_SIZE = 5000;
    private startupTime: number; // 启动时间戳，用于过滤历史数据

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
        this.startupTime = Date.now(); // 记录启动时间

        // 初始化Info客户端
        const transport = new hl.HttpTransport({
            timeout: 30000,
            isTestnet: false
        });
        this.infoClient = new hl.InfoClient({ transport });

        logger.info('🔧 RPC现货监听器初始化完成', {
            activeAddresses: this.addresses.length,
            pollingInterval: `${this.POLLING_INTERVAL / 1000}s`,
            strategy: 'HTTP轮询 + 账本更新查询',
            startupTime: new Date(this.startupTime).toISOString()
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

            // 启动定期状态报告
            this.startStatusReporting();

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

                // 🔧 增强错误处理：区分网络错误和其他错误
                const isNetworkError = this.isNetworkError(error);
                const errorType = isNetworkError ? '网络错误' : '其他错误';

                logger.warn(`⚠️ ${address.label}现货监控${errorType}`, {
                    error: error instanceof Error ? error.message : error,
                    isNetworkError,
                    consecutiveErrors: this.stats.consecutiveErrors,
                    nextAction: isNetworkError ? '继续正常轮询' : '可能增加延迟'
                });

                // 🔧 对于网络错误，更宽松的处理策略
                if (isNetworkError) {
                    // 网络错误：记录但继续运行，不增加长延迟
                    if (this.stats.consecutiveErrors > 15) {
                        logger.warn(`${address.label}连续网络错误过多，但继续尝试`, {
                            consecutiveErrors: this.stats.consecutiveErrors,
                            strategy: '保持正常轮询间隔',
                            note: '网络问题通常是暂时的'
                        });
                    }
                    // 对于网络错误，不使用长延迟，继续正常轮询
                } else {
                    // 非网络错误：使用原有的延迟策略
                    if (this.stats.consecutiveErrors > 5) {
                        logger.warn(`${address.label}连续非网络错误过多，暂停轮询60秒`);
                        setTimeout(() => {
                            if (this.isRunning) {
                                this.startAddressPolling(address);
                            }
                        }, 60000);
                        return;
                    }
                }
            }

            // 继续轮询
            if (this.isRunning) {
                setTimeout(pollAddress, this.POLLING_INTERVAL);
            }
        };

        // 立即开始第一次轮询
        setTimeout(pollAddress, Math.random() * 5000); // 随机延迟0-5秒，避免所有地址同时查询

        logger.info(`🔄 开始轮询${address.label}`, {
            address: address.address.slice(0, 6) + '...' + address.address.slice(-4),
            pollingInterval: `${this.POLLING_INTERVAL / 1000}s`
        });
    }

    /**
     * 启动定期状态报告
     */
    private startStatusReporting(): void {
        const reportInterval = setInterval(() => {
            if (!this.isRunning) {
                clearInterval(reportInterval);
                return;
            }

            const stats = this.getStats();
            const timeSinceLastPoll = Date.now() - this.stats.lastSuccessfulPoll;

            logger.info('📊 RPC现货监听器状态报告', {
                uptime: `${stats.uptime}s`,
                isHealthy: timeSinceLastPoll < 120000, // 2分钟内有成功轮询
                totalRequests: this.stats.totalRequests,
                totalErrors: this.stats.totalErrors,
                totalEvents: this.stats.totalEvents,
                transfersProcessed: this.stats.transfersProcessed,
                successRate: stats.successRate,
                lastSuccessfulPoll: timeSinceLastPoll < 60000 ? `${Math.floor(timeSinceLastPoll / 1000)}s ago` : 'Over 1 min ago',
                cacheSize: stats.cacheSize,
                addressesMonitored: this.stats.addressesMonitored
            });
        }, 5 * 60 * 1000); // 每5分钟报告一次
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
                logger.info(`📊 ${address.label}获取到${ledgerUpdates.length}个账本更新`, {
                    timeRange: `${new Date(startTime).toISOString()} - ${new Date(endTime).toISOString()}`
                });

                // 处理每个账本更新
                for (const update of ledgerUpdates) {
                    await this.processLedgerUpdate(update, address);
                }
            } else {
                // 即使没有更新也记录，证明轮询在工作
                logger.debug(`📋 ${address.label}无新的账本更新`, {
                    timeRange: `${new Date(startTime).toISOString()} - ${new Date(endTime).toISOString()}`
                });
            }

            // 更新最后处理时间
            this.lastProcessedTime.set(address.address, endTime);
            this.stats.lastSuccessfulPoll = Date.now();

        } catch (error) {
            logger.error(`❌ 查询${address.label}账本更新失败:`, error);
            throw error;
        }

        // 记录轮询活动（每小时记录一次以证明程序在运行）
        const now = Date.now();
        const lastHeartbeat = this.lastProcessedTime.get(`${address.address}_heartbeat`) || 0;
        if (now - lastHeartbeat > 3600000) { // 1小时
            logger.info(`💓 ${address.label}轮询心跳`, {
                lastCheck: new Date(endTime).toISOString(),
                noActivitySince: this.lastProcessedTime.get(address.address)
                    ? new Date(this.lastProcessedTime.get(address.address)!).toISOString()
                    : '系统启动'
            });
            this.lastProcessedTime.set(`${address.address}_heartbeat`, now);
        }
    }

    /**
     * 处理账本更新
     */
    private async processLedgerUpdate(update: any, address: WatchedAddress): Promise<void> {
        try {
            // 🔍 检查是否是启动前的历史数据
            if (update.time && update.time < this.startupTime) {
                logger.debug(`⏭️ 跳过启动前的历史数据`, {
                    address: address.label,
                    updateTime: new Date(update.time).toISOString(),
                    startupTime: new Date(this.startupTime).toISOString()
                });
                return; // 跳过历史数据
            }

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
        if (!update.delta) return false;

        // 检查更新类型 - 扩展的转账类型识别
        const transferTypes = [
            'spotTransfer',     // 现货转账
            'deposit',          // 存款
            'withdraw',         // 提款
            'internalTransfer', // 内部转账
            'cStakingTransfer', // 质押转账
            'accountClassTransfer', // 账户类别转账
            'subAccountTransfer'    // 子账户转账
        ];

        // 检查delta.type
        if (update.delta.type && transferTypes.includes(update.delta.type)) {
            return true;
        }

        // 检查传统的余额变化格式
        if (update.delta.USDC || update.delta.coin) {
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
            let usdcValue = 0;

            // 解析余额变化 - 改进的解析逻辑
            if (update.delta) {
                // 1. 处理现货转账
                if (update.delta.type === 'spotTransfer') {
                    asset = update.delta.token || 'UNKNOWN';
                    amount = Math.abs(parseFloat(update.delta.amount || '0')).toString();
                    usdcValue = parseFloat(update.delta.usdcValue || '0');

                    // 判断转账方向
                    if (update.delta.user === address.address) {
                        eventType = 'transfer_out'; // 该地址是发送方
                    } else if (update.delta.destination === address.address) {
                        eventType = 'transfer_in';  // 该地址是接收方
                    }

                    logger.debug(`🔄 现货转账解析`, {
                        asset, amount, usdcValue, eventType,
                        user: update.delta.user,
                        destination: update.delta.destination,
                        address: address.address
                    });
                }
                // 2. 处理存取款
                else if (update.delta.type === 'deposit') {
                    asset = 'USDC';
                    amount = Math.abs(parseFloat(update.delta.usdc || '0')).toString();
                    usdcValue = parseFloat(amount);
                    eventType = 'deposit';
                }
                else if (update.delta.type === 'withdraw') {
                    asset = 'USDC';
                    amount = Math.abs(parseFloat(update.delta.usdc || '0')).toString();
                    usdcValue = parseFloat(amount);
                    eventType = 'withdraw';
                }
                // 3. 处理质押转账
                else if (update.delta.type === 'cStakingTransfer') {
                    asset = update.delta.token || 'HYPE';
                    amount = Math.abs(parseFloat(update.delta.amount || '0')).toString();
                    eventType = update.delta.isDeposit ? 'deposit' : 'withdraw';

                    // 估算HYPE的价值（使用历史价格或固定估算）
                    if (asset === 'HYPE') {
                        usdcValue = parseFloat(amount) * 40; // 估算$40/HYPE
                    }
                }
                // 4. 处理内部转账
                else if (update.delta.type === 'internalTransfer') {
                    asset = 'USDC';
                    amount = Math.abs(parseFloat(update.delta.usdc || '0')).toString();
                    usdcValue = parseFloat(amount);

                    if (update.delta.user === address.address) {
                        eventType = 'transfer_out';
                    } else {
                        eventType = 'transfer_in';
                    }
                }
                // 5. 兜底：处理传统的USDC/coin格式
                else if (update.delta.USDC) {
                    amount = Math.abs(parseFloat(update.delta.USDC)).toString();
                    asset = 'USDC';
                    usdcValue = parseFloat(amount);
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

            // 检查是否达到阈值 - 使用USDC价值或估算价值
            const notionalValue = usdcValue || parseFloat(amount);
            if (notionalValue < 100) {
                return null; // 小于$100阈值
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
                    usdcValue: usdcValue.toString(),
                    transferType: update.delta?.type || 'unknown',
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
}

export default RpcSpotMonitor;