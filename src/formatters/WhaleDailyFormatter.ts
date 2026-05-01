import { ContractTrader } from '../types';
import { AssetPosition, UserPositionState } from '../managers/PositionStateManager';
import { WhaleOpenRecord } from '../managers/WhaleOpenTimeStore';
import { formatTradeSize, formatCurrency, formatPercentage } from '../utils/formatters';

/**
 * 每个地址 × 每个持仓的一条播报条目
 */
export interface DailyPositionEntry {
    trader: ContractTrader;
    position: AssetPosition;
    markPrice: number | null;        // 当前标记价格（来自 allMids）
    openRecord: WhaleOpenRecord | null; // 开仓时间记录（可为 null）
}

/**
 * 鲸鱼每日持仓播报格式化器（模块二）
 *
 * 规则：
 *   - 无持仓的地址 不出现在消息中
 *   - 全部地址均无持仓 → 返回 null，由调度器决定不发送
 *   - 一条消息包含所有有持仓的地址，每个地址下逐仓位列出字段
 */
export class WhaleDailyFormatter {
    format(entries: DailyPositionEntry[], now: Date): string | null {
        if (entries.length === 0) return null;

        const byAddress = this.groupByAddress(entries);
        const lines: string[] = [];
        lines.push(`🐋 **鲸鱼每日持仓播报** (${this.renderDate(now)})`);
        lines.push(this.divider());
        lines.push(`📊 有持仓地址: ${byAddress.size} 个`);
        lines.push('');

        for (const [address, items] of byAddress) {
            const trader = items[0].trader;
            const addrShort = `${address.slice(0, 6)}...${address.slice(-4)}`;
            lines.push(`👛 **${trader.label}** | ${addrShort}`);

            items.forEach((entry, idx) => {
                lines.push(...this.renderPositionBlock(entry, idx + 1, items.length));
            });
            lines.push(this.divider());
        }

        return lines.join('\n');
    }

    private groupByAddress(entries: DailyPositionEntry[]): Map<string, DailyPositionEntry[]> {
        const map = new Map<string, DailyPositionEntry[]>();
        for (const e of entries) {
            const key = e.trader.address.toLowerCase();
            const list = map.get(key) || [];
            list.push(e);
            map.set(key, list);
        }
        return map;
    }

    private renderPositionBlock(
        entry: DailyPositionEntry,
        index: number,
        total: number
    ): string[] {
        const { position: pos, markPrice, openRecord } = entry;
        const side = pos.side === 'long' ? 'long' : 'short';
        const sideEmoji = side === 'long' ? '📈' : '📉';
        const sideText = side === 'long' ? '多仓' : '空仓';

        const entryPrice = pos.entryPrice;
        const notional = markPrice !== null
            ? pos.size * markPrice
            : (pos.notionalValue ?? pos.size * entryPrice);


        // 盈亏百分比以占用保证金为基（ROE）
        const base = (pos.marginUsed && pos.marginUsed > 0)
            ? pos.marginUsed
            : (pos.size * entryPrice);
        const pnlPercent = base > 0 ? (pos.unrealizedPnl / base) * 100 : undefined;
        const pnlEmoji = pos.unrealizedPnl >= 0 ? '🟢' : '🔴';
        // 修复：亏损分支也需要加 "-" 符号
        const pnlSign = pos.unrealizedPnl >= 0 ? '+' : '-';
        const pnlText = `${pnlEmoji} ${pnlSign}$${formatCurrency(Math.abs(pos.unrealizedPnl))}`
            + (pnlPercent !== undefined ? ` (${formatPercentage(pnlPercent)})` : '');

        const leverageText = pos.leverage
            ? `${pos.leverage.value}x (${pos.leverage.type === 'isolated' ? '逐仓' : '全仓'})`
            : '未知';
        const marginText = pos.marginUsed !== undefined
            ? `$${formatCurrency(pos.marginUsed)}`
            : '未知';
        const liqText = pos.liquidationPx !== null && pos.liquidationPx !== undefined
            ? `$${formatCurrency(pos.liquidationPx)}`
            : '无（全仓/不可用）';
        const fundingText = pos.cumFundingAllTime !== undefined
            ? `${pos.cumFundingAllTime >= 0 ? '+' : '-'}$${formatCurrency(Math.abs(pos.cumFundingAllTime))}`
            : '未知';
        const markPriceText = markPrice !== null
            ? `$${formatCurrency(markPrice)}`
            : '未知';
        const openTimeText = openRecord
            ? this.renderTime(openRecord.openTime)
            : '未知（监控启动前已开仓）';


        const header = total > 1
            ? `  ┌─ ${sideEmoji} **[${index}/${total}] ${pos.asset}** ${sideText}`
            : `  ┌─ ${sideEmoji} **${pos.asset}** ${sideText}`;
        return [
            header,
            `  │ 💱 **交易对**: ${pos.asset}-USD`,
            `  │ 💰 **开仓价**: $${formatCurrency(entryPrice)} | 📍 **标记价**: ${markPriceText}`,
            `  │ 📦 **仓位规模**: ${formatTradeSize(pos.size)} ${pos.asset}`,
            `  │ 🏦 **仓位价值**: $${formatCurrency(notional)}`,
            `  │ ⚡ **杠杆**: ${leverageText} | 💵 **占用保证金**: ${marginText}`,
            `  │ ⚠️ **强平价**: ${liqText}`,
            `  │ 💹 **未实现盈亏**: ${pnlText}`,
            `  │ 💸 **累计资金费**: ${fundingText}`,
            `  └─ ⏰ **开仓时间**: ${openTimeText}`
        ];
    }

    private renderDate(d: Date): string {
        // 使用上海时间输出（固定）
        const fmt = new Intl.DateTimeFormat('zh-CN', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hour12: false
        });
        return fmt.format(d) + ' (Asia/Shanghai)';
    }

    private renderTime(ms: number): string {
        return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    }

    private divider(): string {
        return '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
    }
}

export default WhaleDailyFormatter;
