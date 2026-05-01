import { ContractTrader, ContractWebhookAlert, MarginAdjustmentEvent } from '../types';
import { AnalyzedContractEvent } from '../managers/TradeClassificationEngine';
import { AssetPosition } from '../managers/PositionStateManager';
import WhaleOpenTimeStore, { WhaleOpenRecord } from '../managers/WhaleOpenTimeStore';
import { formatTradeSize, formatCurrency, formatPercentage } from '../utils/formatters';
import logger from '../logger';

/**
 * 鲸鱼告警格式化器（模块一）
 *
 * 只处理需求明确列出的 4 种事件：
 *   - 开仓（position_open_long / position_open_short）
 *   - 平仓（position_close）
 *   - 加保证金 / 减保证金（MarginAdjustmentEvent，仅逐仓）
 *
 * 加仓 / 减仓 / 反手 / 无变化 不发送（需求未列入）。
 *
 * 输出：ContractWebhookAlert + formattedMessage，复用现有 webhook 发送路径。
 */
export class WhaleAlertFormatter {
    private openTimeStore: WhaleOpenTimeStore;

    constructor(openTimeStore: WhaleOpenTimeStore) {
        this.openTimeStore = openTimeStore;
    }

    /**
     * 将已分类的合约事件转为鲸鱼告警，不属于需求事件类型的返回 null
     */
    async formatContractEvent(
        event: AnalyzedContractEvent,
        trader: ContractTrader
    ): Promise<ContractWebhookAlert | null> {
        switch (event.eventType) {
            case 'position_open_long':
            case 'position_open_short':
                return this.formatOpen(event, trader);
            case 'position_close':
                return this.formatClose(event, trader);
            default:
                logger.debug('🐋 鲸鱼告警跳过（非开仓/平仓事件）', {
                    trader: trader.label,
                    asset: event.asset,
                    eventType: event.eventType
                });
                return null;
        }
    }

    /**
     * 逐仓保证金调整事件 → 告警
     */
    async formatMarginAdjustment(
        event: MarginAdjustmentEvent,
        trader: ContractTrader,
        positionAfter: AssetPosition | null
    ): Promise<ContractWebhookAlert> {
        return this.buildMarginAlert(event, trader, positionAfter);
    }


    // ========== 开仓 ==========
    private async formatOpen(
        event: AnalyzedContractEvent,
        trader: ContractTrader
    ): Promise<ContractWebhookAlert> {
        const afterPos = event.positionAfter as AssetPosition | null;

        // 开仓信息优先用 positionAfter（API 返回的均价+杠杆+保证金），缺失时回退到 fill
        const entryPrice = afterPos?.entryPrice ?? parseFloat(event.price);
        const size = afterPos?.size ?? parseFloat(event.size);
        const notional = afterPos?.notionalValue ?? (size * entryPrice);
        const leverageText = this.renderLeverage(afterPos?.leverage);
        const marginUsed = afterPos?.marginUsed;

        // fill 时间作为开仓时间（事件触发即首单成交时刻）
        const openTimeMs = event.blockTime > 1e12 ? event.blockTime : event.blockTime * 1000;

        // 持久化开仓记录（平仓时查询用）
        const side: 'long' | 'short' = event.side === 'long' ? 'long' : 'short';
        const record: WhaleOpenRecord = {
            openTime: openTimeMs,
            entryPrice,
            openSize: size,
            side,
            asset: event.asset,
            address: trader.address
        };
        await this.openTimeStore.recordOpen(record);

        const formattedMessage = this.renderOpenMessage({
            trader, event, entryPrice, size, notional,
            leverageText, marginUsed, openTimeMs, side
        });

        return this.wrapAlert(event, trader, 'position_open_' + side as any, formattedMessage);
    }


    // ========== 平仓 ==========
    private async formatClose(
        event: AnalyzedContractEvent,
        trader: ContractTrader
    ): Promise<ContractWebhookAlert> {
        const beforePos = event.positionBefore as AssetPosition | null;

        // 原持仓（开仓时）信息来自 positionBefore（classifyTrade 在延迟前抓取）
        const entryPrice = beforePos?.entryPrice ?? 0;
        const openSize = beforePos?.size ?? parseFloat(event.size);
        const originalNotional = beforePos?.notionalValue ?? (openSize * entryPrice);
        const leverageText = this.renderLeverage(beforePos?.leverage);
        const marginUsedBefore = beforePos?.marginUsed;
        const side: 'long' | 'short' = (beforePos?.side && beforePos.side !== 'none')
            ? beforePos.side
            : (event.side === 'long' ? 'long' : 'short');

        const exitPrice = parseFloat(event.price);
        const closeTimeMs = event.blockTime > 1e12 ? event.blockTime : event.blockTime * 1000;

        // 盈亏（TradeClassificationEngine 已算好 realizedPnL；若缺失则本地兜底计算）
        const realizedPnL = event.realizedPnL ?? this.fallbackRealizedPnL(
            entryPrice, exitPrice, openSize, side
        );
        // 百分比以占用保证金为基（ROE）；保证金缺失时降级为 entryValue
        const pnlBase = (marginUsedBefore && marginUsedBefore > 0) ? marginUsedBefore : originalNotional;
        const pnlPercent = (realizedPnL !== undefined && pnlBase > 0)
            ? (realizedPnL / pnlBase) * 100
            : undefined;

        // 查询开仓时间（可能为 null = 监控前已有仓位）
        const openRecord = await this.openTimeStore.getOpen(trader.address, event.asset);
        await this.openTimeStore.clearOpen(trader.address, event.asset);

        const formattedMessage = this.renderCloseMessage({
            trader, event, side, entryPrice, exitPrice, openSize,
            originalNotional, leverageText, marginUsedBefore,
            realizedPnL, pnlPercent, openRecord, closeTimeMs
        });

        return this.wrapAlert(event, trader, 'position_close', formattedMessage);
    }


    // ========== 保证金调整 ==========
    private buildMarginAlert(
        event: MarginAdjustmentEvent,
        trader: ContractTrader,
        positionAfter: AssetPosition | null
    ): ContractWebhookAlert {
        const isAdd = event.amount > 0;
        const actionLabel = isAdd ? '加保证金' : '减保证金';
        const actionEmoji = isAdd ? '➕' : '➖';

        const sideText = positionAfter?.side && positionAfter.side !== 'none'
            ? (positionAfter.side === 'long' ? '多仓' : '空仓')
            : '未知';
        const sideEmoji = positionAfter?.side === 'long' ? '📈'
            : positionAfter?.side === 'short' ? '📉' : '❓';

        const formattedMessage = this.renderMarginMessage({
            trader, event, isAdd, actionLabel, actionEmoji,
            sideText, sideEmoji, positionAfter
        });

        const alertType = isAdd ? 'position_update' : 'position_update';
        return {
            timestamp: event.timestamp,
            alertType: alertType as any,
            address: trader.address,
            traderLabel: trader.label,
            asset: event.asset,
            size: '0',
            price: '0',
            side: positionAfter?.side === 'short' ? 'short' : 'long',
            txHash: event.hash || '',
            blockTime: Math.floor(event.timestamp / 1000),
            ...(({ formattedMessage } as any))
        } as ContractWebhookAlert;
    }


    // ========== 辅助：包装 ContractWebhookAlert ==========
    private wrapAlert(
        event: AnalyzedContractEvent,
        trader: ContractTrader,
        alertType: ContractWebhookAlert['alertType'],
        formattedMessage: string
    ): ContractWebhookAlert {
        return {
            timestamp: event.timestamp,
            alertType,
            address: trader.address,
            traderLabel: trader.label,
            asset: event.asset,
            size: event.size,
            price: event.price,
            side: event.side,
            txHash: event.hash,
            blockTime: event.blockTime,
            notionalValue: event.metadata?.notionalValue,
            realizedPnL: event.realizedPnL,
            ...(({ formattedMessage } as any))
        } as ContractWebhookAlert;
    }

    private renderLeverage(leverage?: { type: 'isolated' | 'cross'; value: number }): string {
        if (!leverage) return '未知';
        const modeText = leverage.type === 'isolated' ? '逐仓' : '全仓';
        return `${leverage.value}x (${modeText})`;
    }

    private renderMoney(n: number | undefined): string {
        if (n === undefined || !isFinite(n)) return '未知';
        return `$${formatCurrency(n)}`;
    }

    private fallbackRealizedPnL(
        entryPrice: number, exitPrice: number, size: number, side: 'long' | 'short'
    ): number | undefined {
        if (!entryPrice || !exitPrice || !size) return undefined;
        return side === 'long'
            ? (exitPrice - entryPrice) * size
            : (entryPrice - exitPrice) * size;
    }

    private renderTime(ms: number): string {
        return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    }

    private renderTraderLine(trader: ContractTrader): string {
        const addr = `${trader.address.slice(0, 6)}...${trader.address.slice(-4)}`;
        return `👛 **地址**: ${addr} (${trader.label})`;
    }

    private renderExplorerLine(address: string): string {
        return `🔗 https://app.hyperliquid.xyz/trade/${address}`;
    }

    private renderDivider(): string {
        return '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
    }


    // ========== 消息渲染 ==========
    private renderOpenMessage(params: {
        trader: ContractTrader; event: AnalyzedContractEvent;
        entryPrice: number; size: number; notional: number;
        leverageText: string; marginUsed?: number; openTimeMs: number;
        side: 'long' | 'short';
    }): string {
        const { trader, event, entryPrice, size, notional,
            leverageText, marginUsed, openTimeMs, side } = params;
        const sideEmoji = side === 'long' ? '📈' : '📉';
        const sideText = side === 'long' ? '多仓' : '空仓';

        const lines = [
            `🐋 **鲸鱼开仓** | ${event.asset} ${sideEmoji} ${sideText}`,
            this.renderDivider(),
            this.renderTraderLine(trader),
            `🎯 **操作类型**: 开仓`,
            `💱 **交易对**: ${event.asset}-USD`,
            `${sideEmoji} **方向**: ${sideText}`,
            `💰 **开仓价格**: $${formatCurrency(entryPrice)}`,
            `📦 **仓位规模**: ${formatTradeSize(size)} ${event.asset}`,
            `🏦 **仓位价值**: ${this.renderMoney(notional)}`,
            `⚡ **杠杆**: ${leverageText}`,
            `💵 **占用保证金**: ${this.renderMoney(marginUsed)}`,
            `⏰ **开仓时间**: ${this.renderTime(openTimeMs)}`,
            this.renderExplorerLine(trader.address)
        ];
        return lines.join('\n');
    }


    private renderCloseMessage(params: {
        trader: ContractTrader; event: AnalyzedContractEvent;
        side: 'long' | 'short'; entryPrice: number; exitPrice: number;
        openSize: number; originalNotional: number; leverageText: string;
        marginUsedBefore?: number; realizedPnL?: number; pnlPercent?: number;
        openRecord: WhaleOpenRecord | null; closeTimeMs: number;
    }): string {
        const { trader, event, side, entryPrice, exitPrice, openSize,
            originalNotional, leverageText, marginUsedBefore,
            realizedPnL, pnlPercent, openRecord, closeTimeMs } = params;
        const sideEmoji = side === 'long' ? '📈' : '📉';
        const sideText = side === 'long' ? '多仓' : '空仓';
        const openTimeText = openRecord
            ? this.renderTime(openRecord.openTime)
            : '未知（监控启动前已开仓）';
        const pnlEmoji = (realizedPnL ?? 0) >= 0 ? '🟢' : '🔴';
        // 修复：亏损分支也需要加 "-" 符号
        const pnlSign = (realizedPnL ?? 0) >= 0 ? '+' : '-';
        const pnlText = realizedPnL !== undefined
            ? `${pnlEmoji} ${pnlSign}$${formatCurrency(Math.abs(realizedPnL))}`
            : '未知';
        const pnlPctText = pnlPercent !== undefined
            ? ` (${formatPercentage(pnlPercent)})`
            : '';

        const lines = [
            `🐋 **鲸鱼平仓** | ${event.asset} ${sideEmoji} ${sideText}`,
            this.renderDivider(),
            this.renderTraderLine(trader),
            `🎯 **操作类型**: 平仓`,
            `💱 **交易对**: ${event.asset}-USD`,
            `${sideEmoji} **方向**: ${sideText}`,
            `💰 **开仓价格**: $${formatCurrency(entryPrice)}`,
            `⏰ **开仓时间**: ${openTimeText}`,
            `📦 **仓位规模**: ${formatTradeSize(openSize)} ${event.asset}`,
            `🏦 **仓位价值**: ${this.renderMoney(originalNotional)}`,
            `⚡ **杠杆**: ${leverageText}`,
            `💵 **占用保证金**: ${this.renderMoney(marginUsedBefore)}`,
            this.renderDivider(),
            `🎯 **平仓价格**: $${formatCurrency(exitPrice)}`,
            `⏰ **平仓时间**: ${this.renderTime(closeTimeMs)}`,
            `💹 **盈亏**: ${pnlText}${pnlPctText}`,
            this.renderExplorerLine(trader.address)
        ];
        return lines.join('\n');
    }


    private renderMarginMessage(params: {
        trader: ContractTrader; event: MarginAdjustmentEvent;
        isAdd: boolean; actionLabel: string; actionEmoji: string;
        sideText: string; sideEmoji: string;
        positionAfter: AssetPosition | null;
    }): string {
        const { trader, event, isAdd, actionLabel, actionEmoji,
            sideText, sideEmoji, positionAfter } = params;
        const amountAbs = Math.abs(event.amount);
        const amountText = `${isAdd ? '+' : '-'}$${formatCurrency(amountAbs)}`;

        const marginAfter = positionAfter?.marginUsed;
        const leverageAfter = this.renderLeverage(positionAfter?.leverage);

        const lines = [
            `🐋 **鲸鱼${actionLabel}** | ${event.asset} ${sideEmoji} ${sideText}`,
            this.renderDivider(),
            this.renderTraderLine(trader),
            `🎯 **操作类型**: ${actionLabel}（逐仓）`,
            `💱 **交易对**: ${event.asset}-USD`,
            `${sideEmoji} **方向**: ${sideText}`,
            `${actionEmoji} **变动金额**: ${amountText}`,
            `💵 **变动后总保证金**: ${this.renderMoney(marginAfter)}`,
            `⚡ **变动后杠杆**: ${leverageAfter}`,
            `⏰ **时间**: ${this.renderTime(event.timestamp)}`,
            this.renderExplorerLine(trader.address)
        ];
        return lines.join('\n');
    }
}

export default WhaleAlertFormatter;
