import { PositionAnalysisReport, PositionAnalysisEngine } from './PositionAnalysisEngine';
import { EnhancedContractEvent } from './TradeClassificationEngine';
import { ContractTrader, ContractWebhookAlert } from '../types';
import logger from '../logger';

/**
 * 增强告警系统
 * 集成持仓分析结果，生成丰富的智能告警
 */
export class EnhancedAlertSystem {
    private analysisEngine: PositionAnalysisEngine;

    // 配置选项
    private config: EnhancedAlertConfig = {
        enablePositionAnalysis: true,
        analysisThreshold: 10,             // 降低到 $10，更容易触发分析
        maxDailyAnalysis: 20,              // 增加到每日20次
        detailLevel: 'enhanced',           // 详细程度
        includeRiskWarnings: false,        // 关闭风险警告
        includeStrategicInsights: false,   // 关闭策略洞察
        customEmojis: true
    };

    // 分析频率控制
    private analysisHistory = new Map<string, number[]>(); // trader.address -> timestamps[]

    private stats = {
        totalAlerts: 0,
        enhancedAlerts: 0,
        basicAlerts: 0,
        analysisSkipped: 0,
        errors: 0
    };

    constructor(analysisEngine: PositionAnalysisEngine, config?: Partial<EnhancedAlertConfig>) {
        this.analysisEngine = analysisEngine;
        if (config) {
            this.config = { ...this.config, ...config };
        }

        logger.info('🚨 增强告警系统初始化完成', {
            config: this.config
        });
    }

    /**
     * 创建增强告警
     */
    async createEnhancedAlert(
        event: EnhancedContractEvent,
        trader: ContractTrader
    ): Promise<EnhancedWebhookAlert> {
        try {
            this.stats.totalAlerts++;

            const notionalValue = parseFloat(event.metadata?.notionalValue || '0');
            const shouldAnalyze = this.shouldPerformAnalysis(trader, notionalValue, event);

            logger.debug(`🔍 处理增强告警`, {
                trader: trader.label,
                asset: event.asset,
                eventType: event.eventType,
                notional: notionalValue,
                shouldAnalyze
            });

            if (shouldAnalyze) {
                return await this.createAnalysisEnhancedAlert(event, trader);
            } else {
                return this.createBasicEnhancedAlert(event, trader);
            }

        } catch (error) {
            this.stats.errors++;
            logger.error(`❌ 创建增强告警失败`, {
                trader: trader.label,
                error: error instanceof Error ? error.message : error
            });

            // 降级到基础告警
            return this.createBasicEnhancedAlert(event, trader);
        }
    }

    /**
     * 创建带持仓分析的增强告警
     */
    private async createAnalysisEnhancedAlert(
        event: EnhancedContractEvent,
        trader: ContractTrader
    ): Promise<EnhancedWebhookAlert> {
        this.stats.enhancedAlerts++;
        this.recordAnalysis(trader.address);

        logger.info(`📊 生成带分析的增强告警`, {
            trader: trader.label,
            asset: event.asset
        });

        // 执行持仓分析
        const analysisReport = await this.analysisEngine.analyzePosition(trader, event.asset);

        if (analysisReport) {
            return this.formatAnalysisAlert(event, trader, analysisReport);
        } else {
            logger.warn(`⚠️ 持仓分析失败，降级到基础告警`);
            return this.createBasicEnhancedAlert(event, trader);
        }
    }

    /**
     * 创建基础增强告警
     */
    private createBasicEnhancedAlert(
        event: EnhancedContractEvent,
        trader: ContractTrader
    ): EnhancedWebhookAlert {
        this.stats.basicAlerts++;

        // 生成更具体的操作描述
        const operationDescription = this.generateOperationDescription(event);

        const alert: EnhancedWebhookAlert = {
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

            // 增强字段
            classification: event.classification,
            positionChange: event.positionChange,
            enhanced: false,
            alertLevel: 'basic',
            
            // 添加操作描述到formattedMessage中
            formattedMessage: this.formatBasicMessage(event, trader, operationDescription)
        };

        return alert;
    }

    /**
     * 格式化带分析的告警
     */
    private formatAnalysisAlert(
        event: EnhancedContractEvent,
        trader: ContractTrader,
        analysis: PositionAnalysisReport
    ): EnhancedWebhookAlert {
        const formattedMessage = this.formatEnhancedMessage(event, trader, analysis);

        logger.info('✅ 增强告警创建完成', {
            trader: trader.label,
            enhanced: true,
            hasFormattedMessage: !!formattedMessage,
            messageLength: formattedMessage?.length || 0,
            riskLevel: analysis.overallRisk.level,
            signalStars: analysis.strategicInsights.signalStars
        });

        const alert: EnhancedWebhookAlert = {
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

            // 增强字段
            classification: event.classification,
            positionChange: event.positionChange,
            enhanced: true,
            alertLevel: 'enhanced',

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
     * 格式化增强告警消息
     */
    private formatEnhancedMessage(
        event: EnhancedContractEvent,
        trader: ContractTrader,
        analysis: PositionAnalysisReport
    ): string {
        const asset = event.asset;
        const side = event.side;
        const size = event.size;
        const price = parseFloat(event.price);
        const notional = parseFloat(event.metadata?.notionalValue || '0');

        const sideEmoji = side === 'long' ? '📈' : '📉';
        const directionText = side === 'long' ? '多仓' : '空仓';
        const actionText = this.getActionText(event.eventType);

        let message = `${sideEmoji} **${asset} ${directionText}${actionText}** - 持仓分析 📊\n`;
        message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

        // 🎯 交易详情
        message += `🎯 **交易详情**\n`;
        message += `👤 **交易员**: ${trader.label} (${trader.address.slice(0, 6)}...${trader.address.slice(-4)})\n`;
        message += `💰 **资产**: ${asset} | ${sideEmoji} **方向**: ${directionText} | 📊 **规模**: ${size}\n`;
        message += `💵 **价格**: $${price.toLocaleString()} | 🏦 **价值**: $${notional.toLocaleString()}\n`;
        message += `⏰ **时间**: ${new Date(event.timestamp).toISOString().replace('T', ' ').slice(0, 19)} UTC\n`;
        message += `🔍 **交易哈希**: https://app.hyperliquid.xyz/explorer/tx/${event.hash}\n\n`;

        // 📋 持仓变化分析
        message += `📋 **持仓变化分析**\n`;
        message += `🔄 **操作类型**: ${event.classification.description}\n`;
        message += `📈 **总持仓**: $${analysis.userPosition.totalNotionalValue.toLocaleString()}\n`;

        // 💼 资产配置分析
        if (analysis.assetAllocation.topAssets.length > 0) {
            message += `💼 **资产配置分析**\n`;
            message += `📊 **当前配置**:\n`;

            analysis.assetAllocation.topAssets.slice(0, 3).forEach(assetItem => {
                const emoji = assetItem.side === 'long' ? '📈' : '📉';
                const changeIndicator = assetItem.asset === event.asset ? ' 🔺' : '';
                message += `• ${assetItem.asset}: ${(assetItem.percentage * 100).toFixed(1)}% ($${assetItem.notionalValue.toLocaleString()}) - ${assetItem.side}${changeIndicator}\n`;
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
        event: EnhancedContractEvent
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
            enhancedRate: this.stats.totalAlerts > 0
                ? Math.round((this.stats.enhancedAlerts / this.stats.totalAlerts) * 100)
                : 0,
            config: this.config
        };
    }

    /**
     * 生成操作描述
     */
    private generateOperationDescription(event: EnhancedContractEvent): string {
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
     * 格式化基础消息
     */
    private formatBasicMessage(
        event: EnhancedContractEvent,
        trader: ContractTrader,
        operationDescription: string
    ): string {
        const asset = event.asset;
        const side = event.side;
        const size = event.size;
        const price = parseFloat(event.price);
        const notional = parseFloat(event.metadata?.notionalValue || '0');

        const sideEmoji = side === 'long' ? '📈' : '📉';
        const directionText = side === 'long' ? '多仓' : '空仓';

        let message = `${sideEmoji} **${asset} ${operationDescription}** 📊\n`;
        message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

        // 🎯 交易详情
        message += `🎯 **交易详情**\n`;
        message += `👤 **交易员**: ${trader.label} (${trader.address.slice(0, 6)}...${trader.address.slice(-4)})\n`;
        message += `💰 **资产**: ${asset} | ${sideEmoji} **方向**: ${directionText} | 📊 **规模**: ${size}\n`;
        message += `💵 **价格**: $${price.toLocaleString()} | 🏦 **价值**: $${notional.toLocaleString()}\n`;
        message += `🔄 **操作**: ${operationDescription}\n`;
        message += `⏰ **时间**: ${new Date(event.timestamp).toISOString().replace('T', ' ').slice(0, 19)} UTC\n`;
        message += `🔍 **交易哈希**: https://app.hyperliquid.xyz/explorer/tx/${event.hash}\n`;

        // 如果有持仓变化信息，显示它
        if (event.positionChange) {
            message += `\n📋 **持仓变化**\n`;
            if (event.positionChange.sizeChange !== 0) {
                const changeSign = event.positionChange.sizeChange > 0 ? '+' : '';
                message += `📊 **数量变化**: ${changeSign}${event.positionChange.sizeChange.toFixed(6)}\n`;
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
                message += `🔍 **分析**: 检测到$${(notional/1000).toFixed(0)}K大额交易，但持仓净变化为零\n`;
                message += `📊 **可能原因**: 同时开平仓、部分平仓后加仓、或复杂交易组合\n`;
            } else {
                message += `🔍 **分析**: 交易活动未导致持仓净变化\n`;
            }
        }

        return message;
    }
}

// 类型定义
export interface EnhancedWebhookAlert extends ContractWebhookAlert {
    // 增强字段
    classification?: {
        type: string;
        description: string;
        confidence: string;
    };
    positionChange?: {
        sizeChange: number;
        sideChanged: boolean;
    };
    enhanced: boolean;
    alertLevel: 'basic' | 'enhanced';

    // 分析数据（仅增强告警）
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

export interface EnhancedAlertConfig {
    enablePositionAnalysis: boolean;
    analysisThreshold: number;
    maxDailyAnalysis: number;
    detailLevel: 'basic' | 'detailed' | 'enhanced';
    includeRiskWarnings: boolean;
    includeStrategicInsights: boolean;
    customEmojis: boolean;
}

export default EnhancedAlertSystem;