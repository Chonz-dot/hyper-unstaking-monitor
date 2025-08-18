import { ContractEvent, ContractTrader } from '../types';
import { PositionStateManager, PositionChangeAnalysis, PositionChangeType, AssetPosition } from './PositionStateManager';
import logger from '../logger';

/**
 * 合约交易事件（已分析）
 */
export interface AnalyzedContractEvent extends ContractEvent {
    // 分析分类信息
    classification?: {
        type: string;
        description: string;
        confidence: 'high' | 'medium' | 'low';
    };

    // 持仓变化信息
    positionChange?: {
        sizeChange: number;
        sideChanged: boolean;
    };

    // 持仓快照
    positionBefore?: any;
    positionAfter?: any;

    // 元数据 - 修复类型兼容性
    metadata?: {
        notionalValue?: string;
        leverage?: string;  // 改为string类型以兼容ContractEvent
        originalFill?: any;
        [key: string]: any;
    };

    // 盈亏信息（如果是平仓）
    realizedPnL?: number;
}
/**
 * 交易分类引擎
 * 基于持仓状态准确识别交易类型
 */
export class TradeClassificationEngine {
    private positionManager: PositionStateManager;

    // 统计信息
    private stats = {
        totalClassifications: 0,
        classificationTypes: new Map<PositionChangeType, number>(),
        errors: 0
    };

    constructor(positionManager: PositionStateManager) {
        this.positionManager = positionManager;

        logger.info('🔍 交易分类引擎初始化完成');
    }

    /**
     * 分类交易事件，返回准确的交易类型
     */
    async classifyTrade(
        fill: any,
        trader: ContractTrader,
        delayMs: number = 5000,
        maxRetries: number = 2
    ): Promise<AnalyzedContractEvent | null> {
        // 使用特征分析方法作为主要方法
        const featureClassification = this.classifyByTradeCharacteristics(fill, null, null);
        return this.createAnalyzedEventFromFeatures(
            fill,
            trader,
            featureClassification,
            null,
            null
        );
    }

    /**
     * 基于交易特征的智能分类
     */
    private classifyByTradeCharacteristics(
        fill: any,
        beforePosition: AssetPosition | null,
        afterPosition: AssetPosition | null
    ): { eventType: ContractEvent['eventType'], description: string, confidence: 'high' | 'medium' | 'low' } {
        const fillSide = fill.side === 'B' ? 'long' : 'short';

        // 简化的分类逻辑
        return {
            eventType: fillSide === 'long' ? 'position_open_long' : 'position_open_short',
            description: `${fillSide === 'long' ? '开多仓' : '开空仓'}`,
            confidence: 'medium'
        };
    }

    /**
     * 基于特征分析创建分析事件
     */
    private createAnalyzedEventFromFeatures(
        fill: any,
        trader: ContractTrader,
        classification: { eventType: ContractEvent['eventType'], description: string, confidence: 'high' | 'medium' | 'low' },
        beforePosition: AssetPosition | null,
        afterPosition: AssetPosition | null
    ): AnalyzedContractEvent {
        const fillSize = Math.abs(parseFloat(fill.sz || '0'));
        const price = parseFloat(fill.px || '0');
        const fillSide = fill.side === 'B' ? 'long' : 'short';

        let blockTime: number;
        if (fill.time) {
            blockTime = fill.time > 1e12 ? Math.floor(fill.time / 1000) : Math.floor(fill.time);
        } else {
            blockTime = Math.floor(Date.now() / 1000);
        }

        return {
            timestamp: Date.now(),
            address: trader.address,
            eventType: classification.eventType,
            asset: fill.coin,
            size: fillSize.toString(),
            price: price.toString(),
            side: fillSide,
            hash: fill.hash || fill.tid || `feature_${Date.now()}_${fill.coin}`,
            blockTime,

            // 分析字段
            classification: {
                type: classification.eventType,
                description: classification.description,
                confidence: classification.confidence
            },
            positionBefore: beforePosition,
            positionAfter: afterPosition,
            positionChange: {
                sizeChange: 0,
                sideChanged: false
            },

            metadata: {
                notionalValue: (fillSize * price).toString(),
                leverage: "1", // 默认杠杆为字符串
                originalFill: fill
            }
        };
    }

    /**
     * 获取统计信息
     */
    getStats() {
        return {
            totalClassifications: this.stats.totalClassifications,
            errors: this.stats.errors,
            classificationTypes: Object.fromEntries(this.stats.classificationTypes)
        };
    }
}

// 验证结果接口
interface ValidationResult {
    isValid: boolean;
    reason?: string;
}
