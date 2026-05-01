import * as hl from '@nktkas/hyperliquid';
import { ContractTrader } from '../types';
import PositionStateManager from '../managers/PositionStateManager';
import WhaleOpenTimeStore from '../managers/WhaleOpenTimeStore';
import WhaleDailyFormatter, { DailyPositionEntry } from '../formatters/WhaleDailyFormatter';
import logger from '../logger';

export type WhaleBroadcastSender = (message: string) => Promise<void>;

/**
 * 每日持仓播报调度器（模块二）
 *
 * 硬编码：每日 09:05 (Asia/Shanghai) 触发。
 * Asia/Shanghai 无夏令时，固定 UTC+8，所以 01:05 UTC。
 *
 * 规则：
 *   - 四个鲸鱼地址均无持仓 → 不发送（formatter 返回 null）
 *   - 有持仓地址的每条仓位逐项展开
 *
 * 依赖（构造注入）：
 *   - infoClient: allMids 查标记价
 *   - positionManager: 用 refreshUserPosition 强制刷新，避免命中 5min 缓存
 *   - openTimeStore: 查每个仓位开仓时间
 *   - sender: webhook 发送回调
 */
export class DailyBroadcastScheduler {
    private readonly infoClient: hl.InfoClient;
    private readonly positionManager: PositionStateManager;
    private readonly openTimeStore: WhaleOpenTimeStore;
    private readonly traders: ContractTrader[];
    private readonly formatter: WhaleDailyFormatter;
    private readonly sender: WhaleBroadcastSender;

    private scheduledTimer: NodeJS.Timeout | null = null;
    private isRunning = false;

    // 硬编码（Asia/Shanghai 09:05 → 01:05 UTC）
    private readonly TARGET_UTC_HOUR = 1;
    private readonly TARGET_UTC_MINUTE = 5;


    constructor(
        infoClient: hl.InfoClient,
        positionManager: PositionStateManager,
        openTimeStore: WhaleOpenTimeStore,
        traders: ContractTrader[],
        sender: WhaleBroadcastSender
    ) {
        this.infoClient = infoClient;
        this.positionManager = positionManager;
        this.openTimeStore = openTimeStore;
        this.traders = traders.filter(t => t.isActive && t.alertProfile === 'whale-watch');
        this.formatter = new WhaleDailyFormatter();
        this.sender = sender;

        logger.info('🐋 DailyBroadcastScheduler 初始化', {
            whaleCount: this.traders.length,
            targetTime: '09:05 Asia/Shanghai (01:05 UTC)'
        });
    }

    start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        this.scheduleNext();
        logger.info('✅ DailyBroadcastScheduler 已启动');
    }

    stop(): void {
        this.isRunning = false;
        if (this.scheduledTimer) {
            clearTimeout(this.scheduledTimer);
            this.scheduledTimer = null;
        }
        logger.info('🛑 DailyBroadcastScheduler 已停止');
    }


    private scheduleNext(): void {
        const nextMs = this.computeNextTargetUTC();
        const waitMs = Math.max(nextMs - Date.now(), 1000);

        logger.info('🐋 已调度下一次播报', {
            nextFire: new Date(nextMs).toISOString(),
            waitHours: (waitMs / 3600000).toFixed(2)
        });

        this.scheduledTimer = setTimeout(() => {
            void this.fireAndReschedule();
        }, waitMs);
    }

    /**
     * 计算下一次目标触发的 UTC 毫秒时间戳
     * 目标: 每日 09:05 Asia/Shanghai = 01:05 UTC（Asia/Shanghai 无夏令时）
     */
    private computeNextTargetUTC(): number {
        const now = new Date();
        const target = new Date(Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate(),
            this.TARGET_UTC_HOUR,
            this.TARGET_UTC_MINUTE,
            0, 0
        ));
        if (target.getTime() <= now.getTime()) {
            target.setUTCDate(target.getUTCDate() + 1);
        }
        return target.getTime();
    }

    private async fireAndReschedule(): Promise<void> {
        try {
            await this.executeBroadcast();
        } catch (error) {
            logger.error('🐋 每日播报执行失败:', error);
        }
        if (this.isRunning) {
            this.scheduleNext();
        }
    }


    /**
     * 立即执行一次播报（供测试/手动触发，公开）
     */
    async executeBroadcast(): Promise<void> {
        logger.info('🐋 开始执行每日持仓播报', {
            whaleCount: this.traders.length
        });

        // 1. 一次性拉 allMids 做标记价查表
        let mids: { [coin: string]: string } = {};
        try {
            mids = await this.infoClient.allMids();
        } catch (error) {
            logger.warn('🐋 allMids 获取失败，标记价将显示"未知"', error);
        }

        // 2. 对每个 trader 拉持仓
        const entries: DailyPositionEntry[] = [];
        for (const trader of this.traders) {
            try {
                // 强制刷新，避免 5min 缓存
                const userPosition = await this.positionManager.refreshUserPosition(trader.address);
                if (!userPosition || userPosition.positions.length === 0) {
                    logger.debug(`🐋 ${trader.label} 无持仓，跳过`);
                    continue;
                }

                for (const pos of userPosition.positions) {
                    const markPriceRaw = mids[pos.asset];
                    const markPrice = markPriceRaw ? parseFloat(markPriceRaw) : null;
                    const openRecord = await this.openTimeStore.getOpen(trader.address, pos.asset);
                    entries.push({ trader, position: pos, markPrice, openRecord });
                }
            } catch (error) {
                logger.warn(`🐋 ${trader.label} 持仓获取失败:`, error);
            }
        }


        // 3. 全部无持仓 → 直接返回
        if (entries.length === 0) {
            logger.info('🐋 所有鲸鱼地址均无持仓，本轮播报跳过发送');
            return;
        }

        // 4. 格式化
        const message = this.formatter.format(entries, new Date());
        if (!message) {
            logger.info('🐋 formatter 返回空，跳过发送');
            return;
        }

        // 5. 发送
        try {
            await this.sender(message);
            logger.info('✅ 每日持仓播报已发送', {
                tradersWithPosition: new Set(
                    entries.map(e => e.trader.address.toLowerCase())
                ).size,
                totalPositions: entries.length,
                messageLength: message.length
            });
        } catch (error) {
            logger.error('🐋 每日播报发送失败:', error);
        }
    }
}

export default DailyBroadcastScheduler;
