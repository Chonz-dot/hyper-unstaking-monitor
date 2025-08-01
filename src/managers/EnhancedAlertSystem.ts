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
        analysisThreshold: 1000,           // $1000 以上开仓才分析
        maxDailyAnalysis: 10,              // 每交易员每日最多10次分析
        detailLevel: 'enhanced',           // 详细程度
        includeRiskWarnings: true,
        includeStrategicInsights: true,
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
            alertLevel: 'basic'
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
            formattedMessage: this.formatEnhancedMessage(event, trader, analysis)
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
        
        let message = `${sideEmoji} **${asset} ${directionText}${actionText}** - 智能持仓分析 📊\n`;
        message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        
        // 🎯 交易详情
        message += `🎯 **交易详情**\n`;
        message += `💰 **资产**: ${asset} | ${sideEmoji} **方向**: ${directionText} | 📊 **规模**: ${size}\n`;
        message += `💵 **价格**: $${price.toLocaleString()} | 🏦 **价值**: $${notional.toLocaleString()}\n`;
        message += `⏰ **时间**: ${new Date(event.timestamp).toISOString().replace('T', ' ').slice(0, 19)} UTC\n\n`;
        
        // 📋 持仓变化分析
        message += `📋 **持仓变化分析**\n`;
        message += `🔄 **操作类型**: ${event.classification.description}\n`;
        message += `📈 **总持仓**: $${analysis.userPosition.totalNotionalValue.toLocaleString()}\n`;
        message += `🎲 **风险度**: ${analysis.overallRisk.temperature} ${analysis.overallRisk.emoji}\n\n`;
        
        // 💼 资产配置分析
        if (analysis.assetAllocation.topAssets.length > 0) {
            message += `💼 **资产配置分析**\n`;
            message += `📊 **当前配置**:\n`;
            
            analysis.assetAllocation.topAssets.slice(0, 2).forEach(assetItem => {
                const emoji = assetItem.side === 'long' ? '📈' : '📉';
                const changeIndicator = assetItem.asset === event.asset ? ' 🔺新增' : '';
                message += `• ${assetItem.asset}: ${(assetItem.percentage * 100).toFixed(1)}% ($${assetItem.notionalValue.toLocaleString()}) - ${assetItem.side}${changeIndicator}\n`;
            });
            
            if (analysis.riskExposure.maxSingleAssetExposure > 0.6) {
                message += `🎯 **集中度风险**: 偏高 (单一资产>${(analysis.riskExposure.maxSingleAssetExposure * 100).toFixed(0)}%)\n\n`;
            } else {
                message += `🎯 **配置评估**: 合理分散\n\n`;
            }
        }
        
        // ⚖️ 风险评估
        message += `⚖️ **风险评估**\n`;
        message += `📊 **杠杆**: ${analysis.riskExposure.effectiveLeverage.toFixed(1)}x`;
        message += ` | 💰 **资金利用**: ${(analysis.riskExposure.capitalUtilization * 100).toFixed(1)}%`;
        message += ` | 🌡️ **风险**: ${analysis.overallRisk.temperature}\n\n`;
        
        // 🧠 策略洞察
        message += `🧠 **策略洞察**\n`;
        message += `📈 **信号强度**: ${analysis.strategicInsights.signalStars}`;
        
        // 获取市场情绪描述
        const sentimentText = this.getSentimentText(analysis.strategicInsights.marketSentiment);
        if (sentimentText) {
            message += ` (${sentimentText})`;
        }
        message += `\n`;
        
        // 添加关键洞察
        if (analysis.strategicInsights.insights.length > 0) {
            const keyInsight = analysis.strategicInsights.insights[0];
            message += `💡 **关键洞察**: ${keyInsight}\n`;
        }
        
        // 添加风险警告
        if (analysis.strategicInsights.riskWarnings.length > 0) {
            const mainWarning = analysis.strategicInsights.riskWarnings[0];
            message += `⚠️ **风险提示**: ${mainWarning}`;
        }
        
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
        
        // 检查是否是开仓操作
        if (!event.eventType.includes('open') && !event.eventType.includes('increase')) {
            this.stats.analysisSkipped++;
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