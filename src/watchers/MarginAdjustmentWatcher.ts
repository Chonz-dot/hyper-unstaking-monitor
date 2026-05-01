import { EventEmitter } from 'events';
import * as hl from '@nktkas/hyperliquid';
import { ContractTrader, MarginAdjustmentEvent } from '../types';
import { AssetPosition } from '../managers/PositionStateManager';
import logger from '../logger';

/**
 * 逐仓保证金调整监听器（基于快照 diff）
 *
 * 背景：Hyperliquid 的 userNonFundingLedgerUpdates 不包含
 * isolatedMarginAdjustment 事件类型，ledger 只有转账/提现/清算等类别。
 * 手动调保证金（updateIsolatedMargin exchange action）不写账本。
 *
 * 所以改用快照 diff：每个 poll cycle 对比同一仓位的 (szi, marginUsed)，
 *   - szi 相同（无交易）但 marginUsed 变化 → 判定为手动保证金调整
 *   - szi 变化（有交易）→ 跳过（主监控器会报告）
 *
 * 首轮只建基线，不产生告警。
 *
 * 所有告警 emit('marginAdjustment', event, trader)，由上层做 formatter + webhook。
 */
export class MarginAdjustmentWatcher extends EventEmitter {
    private readonly infoClient: hl.InfoClient;
    private readonly traders: ContractTrader[];
    private readonly pollInterval: number;
    private readonly absThreshold: number = 0.1;   // $0.10 绝对阈值
    private readonly relThreshold: number = 0.005; // 0.5% 相对阈值

    private pollingTimer: NodeJS.Timeout | null = null;
    private isRunning = false;

    // 上次快照：address → asset → { szi, marginUsed, side }
    private snapshots: Map<string, Map<string, IsolatedSnapshot>> = new Map();

    private stats = {
        pollCycles: 0,
        adjustmentsDetected: 0,
        errors: 0,
        lastPollAt: 0
    };


    constructor(
        infoClient: hl.InfoClient,
        traders: ContractTrader[],
        pollIntervalMs: number = 120_000
    ) {
        super();
        this.infoClient = infoClient;
        this.traders = traders.filter(t => t.isActive && t.alertProfile === 'whale-watch');
        this.pollInterval = pollIntervalMs;

        logger.info('🐋 MarginAdjustmentWatcher 初始化', {
            whaleCount: this.traders.length,
            pollInterval: `${pollIntervalMs / 1000}s`,
            absThreshold: `$${this.absThreshold}`,
            relThreshold: `${this.relThreshold * 100}%`
        });
    }

    async start(): Promise<void> {
        if (this.isRunning) return;
        this.isRunning = true;

        // 立即建基线（不告警），之后按 interval 轮询
        try {
            await this.establishBaseline();
        } catch (err) {
            logger.warn('🐋 MarginAdjustmentWatcher 基线建立失败（将在首次轮询重试）:', err);
        }

        this.pollingTimer = setInterval(() => {
            void this.pollAll();
        }, this.pollInterval);

        logger.info('✅ MarginAdjustmentWatcher 已启动');
    }

    async stop(): Promise<void> {
        this.isRunning = false;
        if (this.pollingTimer) {
            clearInterval(this.pollingTimer);
            this.pollingTimer = null;
        }
        logger.info('🛑 MarginAdjustmentWatcher 已停止');
    }

    getStats() {
        return { ...this.stats, whaleCount: this.traders.length };
    }


    /**
     * 建立基线：启动时拉一次快照但不产生告警
     */
    private async establishBaseline(): Promise<void> {
        logger.info('🐋 MarginAdjustmentWatcher 建立基线快照...');

        for (const trader of this.traders) {
            try {
                const snapshot = await this.captureSnapshot(trader);
                this.snapshots.set(trader.address.toLowerCase(), snapshot);
                logger.info('🐋 基线已记录', {
                    trader: trader.label,
                    isolatedPositions: snapshot.size
                });
            } catch (error) {
                logger.warn(`🐋 ${trader.label} 基线建立失败:`, error);
            }
        }

        logger.info('✅ MarginAdjustmentWatcher 基线建立完成', {
            tradersWithSnapshot: this.snapshots.size
        });
    }

    /**
     * 一次性对所有鲸鱼做 poll + diff
     */
    private async pollAll(): Promise<void> {
        if (!this.isRunning) return;
        this.stats.pollCycles++;
        this.stats.lastPollAt = Date.now();

        for (const trader of this.traders) {
            try {
                await this.pollAndDiff(trader);
            } catch (error) {
                this.stats.errors++;
                logger.warn(`🐋 ${trader.label} 保证金轮询失败:`, error);
            }
        }
    }


    /**
     * 对单个 trader 执行 diff
     */
    private async pollAndDiff(trader: ContractTrader): Promise<void> {
        const addrKey = trader.address.toLowerCase();
        const prevSnapshot = this.snapshots.get(addrKey);
        const currentSnapshot = await this.captureSnapshot(trader);

        // 没有基线（首次进入该 trader 的轮询）→ 只记录，不告警
        if (!prevSnapshot) {
            this.snapshots.set(addrKey, currentSnapshot);
            return;
        }

        // 对比同 coin 的 (szi, marginUsed)
        for (const [coin, curr] of currentSnapshot) {
            const prev = prevSnapshot.get(coin);
            if (!prev) continue; // 新仓位 → 不报（主监控器会报开仓）

            // 用字符串比较 szi 精确一致（避免浮点误差），不一致 = 有成交
            if (prev.sziRaw !== curr.sziRaw) continue;

            const delta = curr.marginUsed - prev.marginUsed;
            const absDelta = Math.abs(delta);
            const relDelta = prev.marginUsed > 0 ? absDelta / prev.marginUsed : 0;
            if (absDelta < this.absThreshold) continue;
            if (relDelta < this.relThreshold) continue;

            // 触发保证金调整事件
            const event: MarginAdjustmentEvent = {
                timestamp: Date.now(),
                address: trader.address,
                asset: coin,
                amount: delta,      // 正=加保证金，负=减保证金
                hash: '',           // ledger 无对应记录，保持空
                ledgerType: 'snapshotDiffIsolated'
            };

            this.stats.adjustmentsDetected++;
            logger.info('🐋 检测到逐仓保证金调整', {
                trader: trader.label,
                asset: coin,
                delta: delta.toFixed(4),
                marginBefore: prev.marginUsed.toFixed(4),
                marginAfter: curr.marginUsed.toFixed(4),
                side: curr.side
            });

            // 上层接收：需要构造 positionAfter 供 formatter 使用
            const positionAfter: AssetPosition = {
                asset: coin,
                size: Math.abs(parseFloat(curr.sziRaw)),
                side: curr.side,
                entryPrice: curr.entryPrice,
                unrealizedPnl: 0,    // formatter 不展示
                leverage: curr.leverage,
                marginUsed: curr.marginUsed
            };

            this.emit('marginAdjustment', event, trader, positionAfter);
        }

        // 无论是否触发告警，更新快照为当前值
        this.snapshots.set(addrKey, currentSnapshot);
    }


    /**
     * 从 API 拉快照，只保留 isolated 仓位（cross 不监控）
     */
    private async captureSnapshot(trader: ContractTrader): Promise<Map<string, IsolatedSnapshot>> {
        const result = new Map<string, IsolatedSnapshot>();
        const state = await this.infoClient.clearinghouseState({
            user: trader.address as `0x${string}`
        });

        if (!state.assetPositions) return result;

        for (const assetPos of state.assetPositions) {
            const pos = assetPos.position;
            if (!pos || pos.szi === '0') continue;
            if (pos.leverage.type !== 'isolated') continue;

            const szi = parseFloat(pos.szi);
            const marginUsed = parseFloat(pos.marginUsed || '0');
            const entryPrice = parseFloat(pos.entryPx || '0');
            const side: 'long' | 'short' = szi > 0 ? 'long' : 'short';

            result.set(pos.coin, {
                sziRaw: pos.szi,
                marginUsed,
                side,
                entryPrice,
                leverage: {
                    type: 'isolated',
                    value: pos.leverage.value
                }
            });
        }

        return result;
    }
}

/**
 * 单个逐仓仓位的快照（缓存用）
 */
interface IsolatedSnapshot {
    sziRaw: string;       // 原始字符串，用于精确比较（避免浮点误差）
    marginUsed: number;   // 单位 USDC
    side: 'long' | 'short';
    entryPrice: number;
    leverage: { type: 'isolated'; value: number };
}

export default MarginAdjustmentWatcher;
