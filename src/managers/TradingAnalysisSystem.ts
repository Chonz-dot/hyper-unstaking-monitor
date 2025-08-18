import { PositionAnalysisReport, PositionAnalysisEngine } from './PositionAnalysisEngine';
import { AnalyzedContractEvent } from './TradeClassificationEngine';
import { ContractTrader, ContractWebhookAlert } from '../types';
import { formatTradeSize, formatPrice, formatCurrency, formatChange } from '../utils/formatters';
import TraderStatsService from '../services/TraderStatsService';
import logger from '../logger';

/**
 * 交易分析系统
 * 集成持仓分析结果，生成丰富的智能告警
 */
export class TradingAnalysisSystem {
    private analysisEngine: PositionAnalysisEngine;
    private traderStats: TraderStatsService;

    // 配置选项
    private config: TradingAnalysisConfig = {
        enablePositionAnalysis: true,
        analysisThreshold: 0,                  // 设置为0，分析所有交易
        maxDailyAnalysis: 100,                 // 增加到每日100次
        detailLevel: 'advanced',               // 详细程度
        includeRiskWarnings: false,            // 关闭风险警告
        includeStrategicInsights: false,       // 关闭策略洞察
        customEmojis: true
    };

    // 分析频率控制
    private analysisHistory = new Map<string, number[]>(); // trader.address -> timestamps[]

    private stats = {
        totalAlerts: 0,
        advancedAlerts: 0,
        basicAlerts: 0,
        analysisSkipped: 0,
        errors: 0
    };

    constructor(analysisEngine: PositionAnalysisEngine, config?: Partial<TradingAnalysisConfig>) {
        this.analysisEngine = analysisEngine;
        this.traderStats = new TraderStatsService();
        if (config) {
            this.config = { ...this.config, ...config };
        }

        logger.info('🚨 交易分析系统初始化完成', {
            config: this.config
        });
    }

    /**
     * 初始化TraderStats连接
     */
    async initialize(): Promise<void> {
        await this.traderStats.connect();
        logger.info('🎯 交易分析系统统计服务已连接');
    }

    /**
     * 创建交易分析告警
     */
    async createTradingAlert(
        event: AnalyzedContractEvent,
        trader: ContractTrader
    ): Promise<TradingWebhookAlert> {
        try {
            this.stats.totalAlerts++;

            const notionalValue = parseFloat(event.metadata?.notionalValue || '0');

            logger.debug(`🔍 处理交易分析告警`, {
                trader: trader.label,
                asset: event.asset,
                eventType: event.eventType,
                notional: notionalValue
            });

            // 🔧 统一使用分析模式，不再区分基础和高级
            return await this.createAnalysisAlert(event, trader);

        } catch (error) {
            this.stats.errors++;
            logger.error(`❌ 创建交易告警失败`, {
                trader: trader.label,
                error: error instanceof Error ? error.message : error
            });

            // 降级到基础告警
            return this.createBasicAlert(event, trader);
        }
    }

    /**
     * 创建带持仓分析的告警
     */
    private async createAnalysisAlert(
        event: AnalyzedContractEvent,
        trader: ContractTrader
    ): Promise<TradingWebhookAlert> {
        this.stats.advancedAlerts++;
        this.recordAnalysis(trader.address);

        logger.info(`📊 生成带分析的交易告警`, {
            trader: trader.label,
            asset: event.asset
        });

        // 执行持仓分析
        const analysisReport = await this.analysisEngine.analyzePosition(trader, event.asset);

        if (analysisReport) {
            return await this.formatAnalysisAlert(event, trader, analysisReport);
        } else {
            logger.warn(`⚠️ 持仓分析失败，降级到基础告警`);
            return this.createBasicAlert(event, trader);
        }
    }

    /**
     * 创建基础告警
     */
    private createBasicAlert(
        event: AnalyzedContractEvent,
        trader: ContractTrader
    ): TradingWebhookAlert {
        this.stats.basicAlerts++;

        // 🔧 修复：为平仓事件计算并设置realizedPnL
        if (event.eventType === 'position_close' && event.positionBefore) {
            const pnl = this.calculateClosedPositionPnL(event);
            if (pnl) {
                event.realizedPnL = pnl.realized;
                logger.info(`💰 计算平仓盈亏`, {
                    trader: trader.label,
                    asset: event.asset,
                    realizedPnL: pnl.realized,
                    percentage: pnl.percentage.toFixed(2) + '%',
                    entryPrice: pnl.details?.entryPrice,
                    exitPrice: pnl.details?.exitPrice
                });
            }
        }

        // 生成更具体的操作描述
        const operationDescription = this.generateOperationDescription(event);

        const alert: TradingWebhookAlert = {
            timestamp: event.timestamp,
            alertType: this.mapEventTypeToAlertType(event.eventType),
            address: event.address,
            traderLabel: trader.label,
            asset: event.asset,
            size: event.size,
            price: event.price,
            side: event.side,
            txHash: event.hash,
            blockTime: event.blockTime,
            notionalValue: event.metadata?.notionalValue,

            // 🔧 修复：传递realizedPnL到告警中
            realizedPnL: event.realizedPnL,

            // 分析字段
            classification: event.classification,
            positionChange: event.positionChange,
            useAdvancedAnalysis: false,
            alertLevel: 'basic',

            // 添加操作描述到formattedMessage中
            formattedMessage: this.formatBasicMessage(event, trader, operationDescription)
        };

        return alert;
    }

    /**
     * 格式化带分析的告警
     */
    private async formatAnalysisAlert(
        event: AnalyzedContractEvent,
        trader: ContractTrader,
        analysis: PositionAnalysisReport
    ): Promise<TradingWebhookAlert> {
        // 🔧 修复：为平仓事件计算并设置realizedPnL
        if (event.eventType === 'position_close' && event.positionBefore) {
            const pnl = this.calculateClosedPositionPnL(event);
            if (pnl) {
                event.realizedPnL = pnl.realized;
                logger.info(`💰 高级分析-计算平仓盈亏`, {
                    trader: trader.label,
                    asset: event.asset,
                    realizedPnL: pnl.realized,
                    percentage: pnl.percentage.toFixed(2) + '%'
                });
            }
        }

        const formattedMessage = await this.formatAdvancedMessage(event, trader, analysis);

        logger.info('✅ 交易分析告警创建完成', {
            trader: trader.label,
            useAdvancedAnalysis: true,
            hasFormattedMessage: !!formattedMessage,
            messageLength: formattedMessage?.length || 0,
            riskLevel: analysis.overallRisk.level,
            signalStars: analysis.strategicInsights.signalStars
        });

        const alert: TradingWebhookAlert = {
            timestamp: event.timestamp,
            alertType: this.mapEventTypeToAlertType(event.eventType),
            address: event.address,
            traderLabel: trader.label,
            asset: event.asset,
            size: event.size,
            price: event.price,
            side: event.side,
            txHash: event.hash,
            blockTime: event.blockTime,
            notionalValue: event.metadata?.notionalValue,

            // 🔧 修复：传递realizedPnL到告警中
            realizedPnL: event.realizedPnL,

            // 分析字段
            classification: event.classification,
            positionChange: event.positionChange,
            useAdvancedAnalysis: true,
            alertLevel: 'advanced',

            // 分析数据
            positionAnalysis: {
                riskLevel: analysis.overallRisk.level,
                riskScore: analysis.overallRisk.score,
                riskTemperature: analysis.overallRisk.temperature,
                signalStrength: analysis.strategicInsights.signalStrength,
                signalStars: analysis.strategicInsights.signalStars
            },

            // 格式化的消息内容
            formattedMessage: formattedMessage
        };

        return alert;
    }

    /**
     * 格式化高级告警消息
     */
    private async formatAdvancedMessage(
        event: AnalyzedContractEvent,
        trader: ContractTrader,
        analysis: PositionAnalysisReport
    ): Promise<string> {
        const asset = event.asset;
        const side = event.side;
        const size = formatTradeSize(event.size);
        const price = formatPrice(parseFloat(event.price));
        const notional = formatCurrency(parseFloat(event.metadata?.notionalValue || '0'));

        const sideEmoji = side === 'long' ? '📈' : '📉';
        const directionText = side === 'long' ? '多仓' : '空仓';
        const actionText = this.getActionText(event.eventType);

        let message = `${sideEmoji} **${asset} ${directionText}${actionText}** - 持仓分析 📊\n`;
        message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

        // 🎯 交易详情
        message += `🎯 **交易详情**\n`;
        message += `👤 **交易员**: ${trader.label} (${trader.address})\n`;
        message += `💰 **资产**: ${asset} | ${sideEmoji} **方向**: ${directionText} | 📊 **规模**: ${size}\n`;
        message += `💵 **价格**: $${price} | 🏦 **价值**: $${notional}\n`;
        message += `⏰ **时间**: ${new Date(event.timestamp).toISOString().replace('T', ' ').slice(0, 19)} UTC\n`;
        message += `🔍 **交易哈希**: https://app.hyperliquid.xyz/explorer/tx/${event.hash}\n`;

        // 🆕 直接获取交易员统计信息，并同时记录当前交易
        try {
            // 🔄 先记录当前交易
            const notionalValue = parseFloat(event.metadata?.notionalValue || '0');
            const alertType = event.eventType;

            // 🔧 改进交易类型识别
            let tradeType: 'open' | 'close' | 'increase' | 'decrease' = 'open';

            if (alertType === 'position_close') {
                tradeType = 'close';
            } else if (alertType === 'position_decrease') {
                tradeType = 'decrease';
            } else if (alertType === 'position_increase') {
                tradeType = 'increase';
            } else if (alertType.includes('open')) {
                tradeType = 'open';
            } else {
                // 基于持仓变化判断
                if (event.positionChange) {
                    const sizeChange = event.positionChange.sizeChange;
                    if (sizeChange > 0) {
                        tradeType = 'increase';
                    } else if (sizeChange < 0) {
                        tradeType = 'decrease';
                    }
                }
            }

            // 🔧 尝试获取盈亏数据（如果是平仓）
            let realizedPnL: number | undefined;
            if (tradeType === 'close') {
                // 这里可以尝试从事件中获取盈亏数据
                // 目前先设为undefined，让统计系统处理
                realizedPnL = undefined;
            }

            logger.debug(`📊 准备记录交易`, {
                trader: trader.address.slice(0, 8),
                asset: event.asset,
                alertType,
                tradeType,
                notionalValue: notionalValue.toFixed(2),
                realizedPnL: realizedPnL || 'N/A'
            });

            // 记录交易
            await this.traderStats.recordTrade(
                trader.address,
                event.asset,
                notionalValue,
                tradeType,
                realizedPnL
            );

            // 📊 获取更新后的统计数据
            const stats = await this.traderStats.getTraderStats(trader.address);
            const formattedStats = this.traderStats.formatStatsForDisplay(stats);

            message += `\n📊 **交易员统计** (${formattedStats.monitoringDays} 窗口)\n`;
            message += `🎯 **总交易**: ${formattedStats.totalTrades} | 🏆 **胜率**: ${formattedStats.winRate}\n`;
            message += `💰 **累计盈亏**: ${formattedStats.totalRealizedPnL}\n`;
            message += `🎮 **表现**: ${formattedStats.performance}\n`;

            // 🔍 添加调试信息
            const debugStats = await this.traderStats.getTraderStats(trader.address);
            message += `🔍 **调试**: 平仓${debugStats.totalClosedPositions}次, 盈利${debugStats.profitablePositions}次, 7天窗口统计\n`;
        } catch (error) {
            logger.warn('📊 获取交易员统计失败:', error);
            message += `\n⚠️ **统计数据**: 暂时无法获取\n`;
        }

        message += `\n`;

        // 📋 持仓变化分析
        message += `📋 **持仓变化分析**\n`;

        // 🆕 格式化操作类型描述
        let operationDescription = event.classification?.description || '交易活动';
        if (event.positionChange && event.positionChange.sizeChange !== 0) {
            const sizeChange = event.positionChange.sizeChange;
            const changeText = formatChange(sizeChange);

            // 替换描述中的数字部分
            if (operationDescription.includes('(') && operationDescription.includes(')')) {
                operationDescription = operationDescription.replace(/\([^)]+\)/, `(${changeText})`);
            } else if (sizeChange > 0) {
                operationDescription += ` (${changeText})`;
            } else {
                operationDescription += ` (${changeText})`;
            }
        }

        message += `🔄 **操作类型**: ${operationDescription}\n`;
        message += `📈 **总持仓**: $${formatCurrency(analysis.userPosition.totalNotionalValue)}\n`;

        // 💼 资产配置分析
        if (analysis.assetAllocation.topAssets.length > 0) {
            message += `💼 **资产配置分析**\n`;
            message += `📊 **当前配置**:\n`;

            analysis.assetAllocation.topAssets.slice(0, 3).forEach(assetItem => {
                const emoji = assetItem.side === 'long' ? '📈' : '📉';
                const changeIndicator = assetItem.asset === event.asset ? ' 🔺' : '';
                message += `• ${assetItem.asset}: ${(assetItem.percentage * 100).toFixed(1)}% ($${formatCurrency(assetItem.notionalValue)}) - ${assetItem.side}${changeIndicator}\n`;
            });

            if (analysis.riskExposure.maxSingleAssetExposure > 0.66) {
                const topAssetPercentage = (analysis.riskExposure.maxSingleAssetExposure * 100).toFixed(0);
                message += `🎯 **集中度**: 单一资产占比 ${topAssetPercentage}%\n\n`;
            } else {
                message += `🎯 **集中度**: 相对分散\n\n`;
            }
        }

        // ⚖️ 风险评估
        message += `⚖️ **风险评估**\n`;
        message += `📊 **杠杆**: ${analysis.riskExposure.effectiveLeverage.toFixed(1)}x`;
        message += ` | 💰 **资金利用**: ${(analysis.riskExposure.capitalUtilization * 100).toFixed(1)}%`;
        message += ` | 🌡️ **风险**: ${analysis.overallRisk.temperature}`;

        return message;
    }

    /**
     * 判断是否应该执行分析
     */
    private shouldPerformAnalysis(
        trader: ContractTrader,
        notionalValue: number,
        event: AnalyzedContractEvent
    ): boolean {
        if (!this.config.enablePositionAnalysis) return false;

        // 检查金额阈值
        if (notionalValue < this.config.analysisThreshold) {
            this.stats.analysisSkipped++;
            return false;
        }

        // 对于大额交易，即使分类为NO_CHANGE也应该进行分析
        const isLargeTransaction = notionalValue >= 10000; // $10,000以上的大额交易

        // 所有有意义的持仓变化都应该进行分析
        const isMeaningfulOperation = event.eventType !== 'no_change' &&
            event.eventType !== 'unknown' &&
            (event.classification &&
                event.classification.type !== 'UNKNOWN' &&
                event.classification.type !== 'FALLBACK');

        // 对于大额交易，即使是NO_CHANGE也值得分析
        const shouldAnalyzeAnyway = isLargeTransaction && event.classification?.type === 'NO_CHANGE';

        if (!isMeaningfulOperation && !shouldAnalyzeAnyway) {
            this.stats.analysisSkipped++;
            logger.debug(`🔄 跳过分析`, {
                trader: trader.label,
                eventType: event.eventType,
                classificationType: event.classification?.type || 'unknown',
                notional: notionalValue,
                reason: isLargeTransaction ? '大额NO_CHANGE但未强制分析' : '非有意义操作'
            });
            return false;
        }

        // 检查频率限制
        if (!this.checkAnalysisFrequency(trader.address)) {
            this.stats.analysisSkipped++;
            return false;
        }

        return true;
    }

    /**
     * 检查分析频率
     */
    private checkAnalysisFrequency(traderAddress: string): boolean {
        const now = Date.now();
        const oneDayAgo = now - 24 * 60 * 60 * 1000;

        let history = this.analysisHistory.get(traderAddress) || [];
        history = history.filter(timestamp => timestamp > oneDayAgo);
        this.analysisHistory.set(traderAddress, history);

        return history.length < this.config.maxDailyAnalysis;
    }

    /**
     * 记录分析
     */
    private recordAnalysis(traderAddress: string): void {
        const history = this.analysisHistory.get(traderAddress) || [];
        history.push(Date.now());
        this.analysisHistory.set(traderAddress, history);
    }

    /**
     * 映射事件类型到告警类型
     */
    private mapEventTypeToAlertType(eventType: string): ContractWebhookAlert['alertType'] {
        const mapping: Record<string, ContractWebhookAlert['alertType']> = {
            'position_open_long': 'position_open_long',
            'position_open_short': 'position_open_short',
            'position_close': 'position_close',
            'position_increase': 'position_update',
            'position_decrease': 'position_update',
            'position_reverse': 'position_reverse'
        };

        return mapping[eventType] || 'position_update';
    }

    /**
     * 获取动作文本
     */
    private getActionText(eventType: string): string {
        const actionMap: Record<string, string> = {
            'position_open_long': '开启',
            'position_open_short': '开启',
            'position_close': '平仓',
            'position_increase': '加仓',
            'position_decrease': '减仓',
            'position_reverse': '反向'
        };

        return actionMap[eventType] || '更新';
    }

    /**
     * 获取市场情绪文本
     */
    private getSentimentText(sentiment: string): string {
        const sentimentMap: Record<string, string> = {
            'bullish': '强看涨',
            'bearish': '强看跌',
            'cautiously_bullish': '谨慎看涨',
            'cautiously_bearish': '谨慎看跌',
            'neutral': '中性'
        };

        return sentimentMap[sentiment] || '';
    }

    /**
     * 获取统计信息
     */
    getStats() {
        return {
            ...this.stats,
            advancedRate: this.stats.totalAlerts > 0
                ? Math.round((this.stats.advancedAlerts / this.stats.totalAlerts) * 100)
                : 0,
            config: this.config
        };
    }

    /**
     * 生成操作描述
     */
    private generateOperationDescription(event: AnalyzedContractEvent): string {
        if (event.classification && event.classification.description) {
            // 对于NO_CHANGE，提供更明确的描述
            if (event.classification.type === 'NO_CHANGE') {
                const notional = parseFloat(event.metadata?.notionalValue || '0');
                if (notional >= 100000) {
                    return '大额交易活动'; // >$10万
                } else if (notional >= 10000) {
                    return '中额交易活动'; // >$1万
                } else {
                    return '交易活动';
                }
            }
            return event.classification.description;
        }

        // 基于事件类型生成描述
        const actionMap: Record<string, string> = {
            'position_open_long': '开多仓',
            'position_open_short': '开空仓',
            'position_close': '平仓',
            'position_increase': '加仓',
            'position_decrease': '减仓',
            'position_reverse': '反向操作',
            'position_update': '持仓更新'
        };

        return actionMap[event.eventType] || '持仓变化';
    }

    /**
     * 计算平仓盈亏
     */
    private calculateClosedPositionPnL(event: AnalyzedContractEvent): {
        realized: number;
        percentage: number;
        details?: {
            entryPrice: number;
            exitPrice: number;
            size: number;
        };
    } | null {
        try {
            if (!event.positionBefore || event.eventType !== 'position_close') {
                return null;
            }

            const beforePosition = event.positionBefore;
            const exitPrice = parseFloat(event.price);

            if (!beforePosition || !exitPrice || beforePosition.size === 0) {
                return null;
            }

            // 计算已实现盈亏
            const entryPrice = beforePosition.entryPrice || 0;
            const size = Math.abs(beforePosition.size);
            const side = beforePosition.side;

            if (entryPrice === 0 || size === 0) {
                return null;
            }

            let realizedPnL: number;

            if (side === 'long') {
                // 多头平仓：(卖出价 - 买入价) * 数量
                realizedPnL = (exitPrice - entryPrice) * size;
            } else {
                // 空头平仓：(买入价 - 卖出价) * 数量
                realizedPnL = (entryPrice - exitPrice) * size;
            }

            // 计算盈亏百分比
            const costBasis = entryPrice * size;
            const percentage = costBasis > 0 ? (realizedPnL / costBasis) * 100 : 0;

            return {
                realized: realizedPnL,
                percentage,
                details: {
                    entryPrice,
                    exitPrice,
                    size
                }
            };

        } catch (error) {
            logger.error('计算平仓盈亏失败:', error);
            return null;
        }
    }

    /**
     * 格式化基础消息
     */
    private formatBasicMessage(
        event: AnalyzedContractEvent,
        trader: ContractTrader,
        operationDescription: string
    ): string {
        const asset = event.asset;
        const side = event.side;

        // 检查是否为平仓事件并计算盈亏
        let pnlInfo = '';
        if (event.eventType === 'position_close' && event.positionBefore) {
            const pnl = this.calculateClosedPositionPnL(event);
            if (pnl) {
                const pnlEmoji = pnl.realized >= 0 ? '💰' : '📉';
                const pnlSign = pnl.realized >= 0 ? '+' : '';
                pnlInfo = `\n💰 **Realized P&L**: ${pnlSign}$${pnl.realized.toFixed(2)} (${pnlSign}${pnl.percentage.toFixed(2)}%) ${pnlEmoji}`;

                if (pnl.details) {
                    pnlInfo += `\n📊 **Entry**: $${pnl.details.entryPrice.toFixed(4)} | **Exit**: $${pnl.details.exitPrice.toFixed(4)}`;
                }
            }
        }
        const size = formatTradeSize(event.size);
        const price = formatPrice(parseFloat(event.price));
        const notional = formatCurrency(parseFloat(event.metadata?.notionalValue || '0'));

        const sideEmoji = side === 'long' ? '📈' : '📉';
        const directionText = side === 'long' ? '多仓' : '空仓';

        let message = `${sideEmoji} **${asset} ${operationDescription}** 📊\n`;
        message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

        // 🎯 交易详情
        message += `🎯 **交易详情**\n`;
        message += `👤 **交易员**: ${trader.label} (${trader.address})\n`;
        message += `💰 **资产**: ${asset} | ${sideEmoji} **方向**: ${directionText} | 📊 **规模**: ${formatTradeSize(size)}\n`;
        message += `💵 **价格**: $${price} | 🏦 **价值**: $${notional}\n`;
        message += `🔄 **操作**: ${operationDescription}\n`;
        message += `⏰ **时间**: ${new Date(event.timestamp).toISOString().replace('T', ' ').slice(0, 19)} UTC\n`;
        message += `🔍 **交易哈希**: https://app.hyperliquid.xyz/explorer/tx/${event.hash}\n`;

        // 添加平仓盈亏信息
        if (pnlInfo) {
            message += pnlInfo + '\n';
        }

        // 如果有持仓变化信息，显示它
        if (event.positionChange) {
            message += `\n📋 **持仓变化**\n`;
            if (event.positionChange.sizeChange !== 0) {
                message += `📊 **数量变化**: ${formatChange(event.positionChange.sizeChange)}\n`;
            }
            if (event.positionChange.sideChanged) {
                message += `🔄 **方向改变**: 是\n`;
            }
        }

        // 对于NO_CHANGE但有大额交易的情况，添加说明
        if (event.classification?.type === 'NO_CHANGE') {
            const notional = parseFloat(event.metadata?.notionalValue || '0');
            message += `\n💡 **交易说明**\n`;
            if (notional >= 100000) {
                message += `🔍 **分析**: 检测到$${(notional / 1000).toFixed(0)}K大额交易，但持仓净变化为零\n`;
                message += `📊 **可能原因**: 同时开平仓、部分平仓后加仓、或复杂交易组合\n`;
            } else {
                message += `🔍 **分析**: 交易活动未导致持仓净变化\n`;
            }
        }

        return message;
    }
}

// 类型定义
export interface TradingWebhookAlert extends ContractWebhookAlert {
    // 分析字段
    classification?: {
        type: string;
        description: string;
        confidence: string;
    };
    positionChange?: {
        sizeChange: number;
        sideChanged: boolean;
    };
    useAdvancedAnalysis: boolean;
    alertLevel: 'basic' | 'advanced';

    // 🔧 添加realizedPnL字段
    realizedPnL?: number;

    // 分析数据（仅高级告警）
    positionAnalysis?: {
        riskLevel: string;
        riskScore: number;
        riskTemperature: string;
        signalStrength: number;
        signalStars: string;
    };

    // 格式化消息
    formattedMessage?: string;
}

export interface TradingAnalysisConfig {
    enablePositionAnalysis: boolean;
    analysisThreshold: number;
    maxDailyAnalysis: number;
    detailLevel: 'basic' | 'detailed' | 'advanced';
    includeRiskWarnings: boolean;
    includeStrategicInsights: boolean;
    customEmojis: boolean;
}

export default TradingAnalysisSystem;