import { PositionStateManager, UserPositionState, AssetPosition } from './PositionStateManager';
import { ContractTrader } from '../types';
import logger from '../logger';

/**
 * 持仓分析引擎
 * 提供多维度的持仓风险分析和策略洞察
 */
export class PositionAnalysisEngine {
    private positionManager: PositionStateManager;
    
    // 默认分析阈值
    private readonly defaultThresholds: AnalysisThresholds = {
        singleAssetConcentration: 0.6,     // 60% 单资产集中度警告
        leverageWarning: 5.0,              // 5倍杠杆警告  
        capitalUtilization: 0.8,           // 80% 资金利用率警告
        riskTemperature: {
            low: 0.3,     // 30% 低风险
            medium: 0.6,  // 60% 中风险
            high: 0.8     // 80% 高风险
        }
    };
    
    // 统计信息
    private stats = {
        totalAnalysis: 0,
        riskLevels: new Map<RiskLevel, number>(),
        averageAnalysisTime: 0,
        errors: 0
    };

    constructor(positionManager: PositionStateManager) {
        this.positionManager = positionManager;
        
        logger.info('📈 持仓分析引擎初始化完成', {
            thresholds: this.defaultThresholds
        });
    }

    /**
     * 分析用户持仓，返回完整的分析报告
     */
    async analyzePosition(
        trader: ContractTrader,
        triggeredByAsset?: string,
        customThresholds?: Partial<AnalysisThresholds>
    ): Promise<PositionAnalysisReport | null> {
        const startTime = Date.now();
        
        try {
            this.stats.totalAnalysis++;
            
            logger.debug(`📊 开始持仓分析`, {
                trader: trader.label,
                triggeredBy: triggeredByAsset
            });
            
            // 获取用户完整持仓状态
            const userPosition = await this.positionManager.getUserPosition(trader.address);
            if (!userPosition) {
                logger.warn(`⚠️ 无法获取用户持仓，跳过分析`, {
                    trader: trader.label
                });
                return null;
            }
            
            // 合并自定义阈值
            const thresholds = { ...this.defaultThresholds, ...customThresholds };
            
            // 执行各维度分析
            const riskExposure = this.analyzeRiskExposure(userPosition, thresholds);
            const assetAllocation = this.analyzeAssetAllocation(userPosition, thresholds);
            const tradingMetrics = this.analyzeTradingMetrics(userPosition, thresholds);
            const strategicInsights = this.generateStrategicInsights(
                userPosition, 
                riskExposure, 
                assetAllocation,
                triggeredByAsset
            );
            
            // 计算综合风险评级
            const overallRisk = this.calculateOverallRisk(riskExposure, assetAllocation, thresholds);
            
            const analysisTime = Date.now() - startTime;
            this.updateStats(overallRisk.level, analysisTime);
            
            const report: PositionAnalysisReport = {
                timestamp: Date.now(),
                trader,
                userPosition,
                riskExposure,
                assetAllocation,
                tradingMetrics,
                overallRisk,
                strategicInsights,
                thresholds,
                triggeredByAsset,
                analysisTime
            };
            
            logger.info(`✅ 持仓分析完成`, {
                trader: trader.label,
                riskLevel: overallRisk.level,
                riskScore: overallRisk.score,
                analysisTime: `${analysisTime}ms`,
                positionsCount: userPosition.positions.length,
                totalValue: userPosition.totalNotionalValue
            });
            
            return report;
            
        } catch (error) {
            this.stats.errors++;
            logger.error(`❌ 持仓分析失败`, {
                trader: trader.label,
                error: error instanceof Error ? error.message : error
            });
            return null;
        }
    }

    /**
     * 风险暴露分析
     */
    private analyzeRiskExposure(
        userPosition: UserPositionState, 
        thresholds: AnalysisThresholds
    ): RiskExposureAnalysis {
        const totalNotional = userPosition.totalNotionalValue;
        const accountValue = userPosition.accountValue;
        const marginUsed = userPosition.totalMarginUsed;
        
        // 计算杠杆倍数
        const effectiveLeverage = accountValue > 0 ? totalNotional / accountValue : 0;
        
        // 计算资金利用率
        const capitalUtilization = accountValue > 0 ? marginUsed / accountValue : 0;
        
        // 计算最大单一资产暴露
        let maxSingleAssetExposure = 0;
        let maxAsset = '';
        for (const position of userPosition.positions) {
            const exposureRatio = totalNotional > 0 ? (position.notionalValue || 0) / totalNotional : 0;
            if (exposureRatio > maxSingleAssetExposure) {
                maxSingleAssetExposure = exposureRatio;
                maxAsset = position.asset;
            }
        }
        
        // 生成风险警告
        const warnings: string[] = [];
        if (effectiveLeverage > thresholds.leverageWarning) {
            warnings.push(`高杠杆风险 (${effectiveLeverage.toFixed(2)}x)`);
        }
        if (capitalUtilization > thresholds.capitalUtilization) {
            warnings.push(`资金利用率过高 (${(capitalUtilization * 100).toFixed(1)}%)`);
        }
        if (maxSingleAssetExposure > thresholds.singleAssetConcentration) {
            warnings.push(`${maxAsset} 过度集中 (${(maxSingleAssetExposure * 100).toFixed(1)}%)`);
        }
        
        return {
            totalNotionalValue: totalNotional,
            accountValue,
            marginUsed,
            effectiveLeverage,
            capitalUtilization,
            maxSingleAssetExposure,
            maxAssetName: maxAsset,
            warnings,
            metrics: {
                leverageScore: Math.min(effectiveLeverage / 10, 1), // 10倍杠杆为满分
                utilizationScore: capitalUtilization,
                concentrationScore: maxSingleAssetExposure
            }
        };
    }

    /**
     * 资产配置分析  
     */
    private analyzeAssetAllocation(
        userPosition: UserPositionState,
        thresholds: AnalysisThresholds
    ): AssetAllocationAnalysis {
        const positions = userPosition.positions;
        const totalValue = userPosition.totalNotionalValue;
        
        // 按资产分组
        const assetBreakdown: AssetBreakdownItem[] = [];
        let longValue = 0;
        let shortValue = 0;
        
        for (const position of positions) {
            const notional = position.notionalValue || 0;
            const percentage = totalValue > 0 ? notional / totalValue : 0;
            
            assetBreakdown.push({
                asset: position.asset,
                size: position.size,
                side: position.side,
                notionalValue: notional,
                percentage,
                unrealizedPnl: position.unrealizedPnl,
                entryPrice: position.entryPrice
            });
            
            if (position.side === 'long') {
                longValue += notional;
            } else if (position.side === 'short') {
                shortValue += notional;
            }
        }
        
        // 按价值排序
        assetBreakdown.sort((a, b) => b.notionalValue - a.notionalValue);
        
        // 计算多空平衡
        const longShortRatio = shortValue > 0 ? longValue / shortValue : (longValue > 0 ? Infinity : 0);
        const netExposure = longValue - shortValue;
        const netExposureRatio = totalValue > 0 ? Math.abs(netExposure) / totalValue : 0;
        
        // 计算多样化程度
        const diversificationScore = this.calculateDiversificationScore(assetBreakdown);
        
        return {
            assetBreakdown,
            longValue,
            shortValue,
            longShortRatio,
            netExposure,
            netExposureRatio,
            diversificationScore,
            topAssets: assetBreakdown.slice(0, 3), // 前3大持仓
            riskConcentration: {
                isHighlyConcentrated: assetBreakdown[0]?.percentage > thresholds.singleAssetConcentration,
                topAssetPercentage: assetBreakdown[0]?.percentage || 0,
                top3Percentage: assetBreakdown.slice(0, 3).reduce((sum, item) => sum + item.percentage, 0)
            }
        };
    }

    /**
     * 交易指标分析
     */
    private analyzeTradingMetrics(
        userPosition: UserPositionState,
        thresholds: AnalysisThresholds
    ): TradingMetricsAnalysis {
        const positions = userPosition.positions;
        const totalPositions = positions.length;
        
        // 计算总盈亏
        const totalUnrealizedPnl = positions.reduce((sum, pos) => sum + pos.unrealizedPnl, 0);
        const totalNotional = userPosition.totalNotionalValue;
        const pnlPercentage = totalNotional > 0 ? (totalUnrealizedPnl / totalNotional) * 100 : 0;
        
        // 分析盈亏分布
        const profitablePositions = positions.filter(pos => pos.unrealizedPnl > 0).length;
        const losingPositions = positions.filter(pos => pos.unrealizedPnl < 0).length;
        const winRate = totalPositions > 0 ? profitablePositions / totalPositions : 0;
        
        // 计算平均持仓大小
        const averagePositionSize = totalPositions > 0 ? totalNotional / totalPositions : 0;
        
        return {
            totalPositions,
            totalUnrealizedPnl,
            pnlPercentage,
            profitablePositions,
            losingPositions,
            winRate,
            averagePositionSize,
            largestPosition: Math.max(...positions.map(pos => pos.notionalValue || 0)),
            smallestPosition: Math.min(...positions.map(pos => pos.notionalValue || 0))
        };
    }

    /**
     * 生成策略洞察
     */
    private generateStrategicInsights(
        userPosition: UserPositionState,
        riskExposure: RiskExposureAnalysis,
        assetAllocation: AssetAllocationAnalysis,
        triggeredByAsset?: string
    ): StrategyInsights {
        const insights: string[] = [];
        const riskWarnings: string[] = [];
        let signalStrength = 0; // 0-5 星级
        
        // 基于杠杆的洞察
        if (riskExposure.effectiveLeverage > 3) {
            if (riskExposure.effectiveLeverage > 8) {
                riskWarnings.push('极高杠杆风险，建议降低仓位');
                signalStrength += 1;
            } else if (riskExposure.effectiveLeverage > 5) {
                riskWarnings.push('高杠杆操作，需密切关注市场');
                signalStrength += 2;
            } else {
                insights.push('适度杠杆操作，风险可控');
                signalStrength += 3;
            }
        } else {
            insights.push('保守杠杆策略，风险较低');
            signalStrength += 2;
        }
        
        // 基于资产配置的洞察
        if (assetAllocation.riskConcentration.isHighlyConcentrated) {
            const topAsset = assetAllocation.topAssets[0];
            riskWarnings.push(`${topAsset.asset} 过度集中 (${(topAsset.percentage * 100).toFixed(1)}%)，建议分散配置`);
        } else if (assetAllocation.diversificationScore > 0.7) {
            insights.push('良好的资产分散配置');
            signalStrength += 1;
        }
        
        // 基于多空平衡的洞察
        if (assetAllocation.netExposureRatio > 0.8) {
            if (assetAllocation.longValue > assetAllocation.shortValue) {
                insights.push('强烈看涨信号，净多头暴露');
                signalStrength += 2;
            } else {
                insights.push('强烈看跌信号，净空头暴露');
                signalStrength += 2;
            }
        } else if (assetAllocation.netExposureRatio < 0.2) {
            insights.push('多空平衡策略，市场中性');
            signalStrength += 1;
        }
        
        // 基于触发资产的洞察
        if (triggeredByAsset) {
            const triggeredPosition = assetAllocation.assetBreakdown.find(item => item.asset === triggeredByAsset);
            if (triggeredPosition) {
                if (triggeredPosition.percentage > 0.3) {
                    insights.push(`${triggeredByAsset} 为重仓配置，信号意义重大`);
                    signalStrength += 1;
                } else {
                    insights.push(`${triggeredByAsset} 为试探性仓位`);
                }
            }
        }
        
        // 综合信号强度评估
        signalStrength = Math.min(signalStrength, 5);
        
        return {
            signalStrength,
            signalStars: '⭐'.repeat(signalStrength),
            marketSentiment: this.assessMarketSentiment(assetAllocation),
            insights,
            riskWarnings,
            recommendations: this.generateRecommendations(riskExposure, assetAllocation)
        };
    }

    /**
     * 计算综合风险评级
     */
    private calculateOverallRisk(
        riskExposure: RiskExposureAnalysis,
        assetAllocation: AssetAllocationAnalysis,
        thresholds: AnalysisThresholds
    ): OverallRisk {
        // 风险评分计算 (0-1)
        const leverageRisk = Math.min(riskExposure.effectiveLeverage / 10, 1);
        const utilizationRisk = riskExposure.capitalUtilization;
        const concentrationRisk = riskExposure.maxSingleAssetExposure;
        const diversificationRisk = 1 - assetAllocation.diversificationScore;
        
        // 加权综合评分
        const riskScore = (
            leverageRisk * 0.3 +
            utilizationRisk * 0.25 +
            concentrationRisk * 0.25 +
            diversificationRisk * 0.2
        );
        
        // 确定风险等级
        let level: RiskLevel;
        let temperature: string;
        let emoji: string;
        
        if (riskScore < thresholds.riskTemperature.low) {
            level = 'low';
            temperature = '🟢 低风险';
            emoji = '😌';
        } else if (riskScore < thresholds.riskTemperature.medium) {
            level = 'medium';
            temperature = '🟡 中等风险';
            emoji = '🤔';
        } else if (riskScore < thresholds.riskTemperature.high) {
            level = 'medium-high';
            temperature = '🟠 中高风险';
            emoji = '😰';
        } else {
            level = 'high';
            temperature = '🔴 高风险';
            emoji = '😱';
        }
        
        return {
            level,
            score: riskScore,
            temperature,
            emoji,
            components: {
                leverage: leverageRisk,
                utilization: utilizationRisk,
                concentration: concentrationRisk,
                diversification: diversificationRisk
            }
        };
    }

    /**
     * 计算多样化分数
     */
    private calculateDiversificationScore(breakdown: AssetBreakdownItem[]): number {
        if (breakdown.length <= 1) return 0;
        
        // 使用 Herfindahl-Hirschman Index (HHI) 的反向指标
        const hhi = breakdown.reduce((sum, item) => sum + Math.pow(item.percentage, 2), 0);
        const maxHHI = 1; // 完全集中时 HHI = 1
        const minHHI = 1 / breakdown.length; // 完全分散时 HHI = 1/n
        
        // 标准化到 0-1 范围
        return Math.max(0, (maxHHI - hhi) / (maxHHI - minHHI));
    }

    /**
     * 评估市场情绪
     */
    private assessMarketSentiment(allocation: AssetAllocationAnalysis): MarketSentiment {
        if (allocation.netExposureRatio > 0.6) {
            return allocation.longValue > allocation.shortValue ? 'bullish' : 'bearish';
        } else if (allocation.netExposureRatio < 0.2) {
            return 'neutral';
        } else {
            return allocation.longValue > allocation.shortValue ? 'cautiously_bullish' : 'cautiously_bearish';
        }
    }

    /**
     * 生成建议
     */
    private generateRecommendations(
        riskExposure: RiskExposureAnalysis,
        assetAllocation: AssetAllocationAnalysis
    ): string[] {
        const recommendations: string[] = [];
        
        if (riskExposure.effectiveLeverage > 5) {
            recommendations.push('考虑降低杠杆或减少仓位规模');
        }
        
        if (riskExposure.capitalUtilization > 0.8) {
            recommendations.push('保留更多资金作为风险缓冲');
        }
        
        if (assetAllocation.riskConcentration.isHighlyConcentrated) {
            recommendations.push('分散投资，避免单一资产过度集中');
        }
        
        if (assetAllocation.diversificationScore < 0.3) {
            recommendations.push('增加资产种类，提高投资组合多样性');
        }
        
        return recommendations;
    }

    /**
     * 更新统计信息
     */
    private updateStats(riskLevel: RiskLevel, analysisTime: number): void {
        const currentCount = this.stats.riskLevels.get(riskLevel) || 0;
        this.stats.riskLevels.set(riskLevel, currentCount + 1);
        
        // 更新平均分析时间
        const totalTime = this.stats.averageAnalysisTime * (this.stats.totalAnalysis - 1) + analysisTime;
        this.stats.averageAnalysisTime = totalTime / this.stats.totalAnalysis;
    }

    /**
     * 获取统计信息
     */
    getStats() {
        const riskDistribution: Record<string, number> = {};
        for (const [level, count] of this.stats.riskLevels.entries()) {
            riskDistribution[level] = count;
        }
        
        return {
            ...this.stats,
            riskDistribution,
            averageAnalysisTime: Math.round(this.stats.averageAnalysisTime),
            successRate: this.stats.totalAnalysis > 0 
                ? Math.round(((this.stats.totalAnalysis - this.stats.errors) / this.stats.totalAnalysis) * 100)
                : 0
        };
    }
}

// 类型定义
export interface PositionAnalysisReport {
    timestamp: number;
    trader: ContractTrader;
    userPosition: UserPositionState;
    riskExposure: RiskExposureAnalysis;
    assetAllocation: AssetAllocationAnalysis;
    tradingMetrics: TradingMetricsAnalysis;
    overallRisk: OverallRisk;
    strategicInsights: StrategyInsights;
    thresholds: AnalysisThresholds;
    triggeredByAsset?: string;
    analysisTime: number;
}

export interface RiskExposureAnalysis {
    totalNotionalValue: number;
    accountValue: number;
    marginUsed: number;
    effectiveLeverage: number;
    capitalUtilization: number;
    maxSingleAssetExposure: number;
    maxAssetName: string;
    warnings: string[];
    metrics: {
        leverageScore: number;
        utilizationScore: number;
        concentrationScore: number;
    };
}

export interface AssetAllocationAnalysis {
    assetBreakdown: AssetBreakdownItem[];
    longValue: number;
    shortValue: number;
    longShortRatio: number;
    netExposure: number;
    netExposureRatio: number;
    diversificationScore: number;
    topAssets: AssetBreakdownItem[];
    riskConcentration: {
        isHighlyConcentrated: boolean;
        topAssetPercentage: number;
        top3Percentage: number;
    };
}

export interface AssetBreakdownItem {
    asset: string;
    size: number;
    side: 'long' | 'short' | 'none';
    notionalValue: number;
    percentage: number;
    unrealizedPnl: number;
    entryPrice: number;
}

export interface TradingMetricsAnalysis {
    totalPositions: number;
    totalUnrealizedPnl: number;
    pnlPercentage: number;
    profitablePositions: number;
    losingPositions: number;
    winRate: number;
    averagePositionSize: number;
    largestPosition: number;
    smallestPosition: number;
}

export interface OverallRisk {
    level: RiskLevel;
    score: number;
    temperature: string;
    emoji: string;
    components: {
        leverage: number;
        utilization: number;
        concentration: number;
        diversification: number;
    };
}

export interface StrategyInsights {
    signalStrength: number;
    signalStars: string;
    marketSentiment: MarketSentiment;
    insights: string[];
    riskWarnings: string[];
    recommendations: string[];
}

export interface AnalysisThresholds {
    singleAssetConcentration: number;
    leverageWarning: number;
    capitalUtilization: number;
    riskTemperature: {
        low: number;
        medium: number;
        high: number;
    };
}

export type RiskLevel = 'low' | 'medium' | 'medium-high' | 'high';
export type MarketSentiment = 'bullish' | 'bearish' | 'neutral' | 'cautiously_bullish' | 'cautiously_bearish';

export default PositionAnalysisEngine;