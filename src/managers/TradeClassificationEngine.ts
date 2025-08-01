import { PositionStateManager, PositionChangeAnalysis, PositionChangeType, AssetPosition } from './PositionStateManager';
import { ContractEvent, ContractTrader } from '../types';
import logger from '../logger';

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
    ): Promise<EnhancedContractEvent | null> {
        let attempt = 0;
        let lastError: string | null = null;
        
        while (attempt <= maxRetries) {
            try {
                this.stats.totalClassifications++;
                
                const asset = fill.coin;
                const fillSize = parseFloat(fill.sz || '0');
                const fillSide = fill.side === 'B' ? 'long' : 'short';
                const price = parseFloat(fill.px || '0');
                const attemptSuffix = attempt > 0 ? ` (重试 ${attempt}/${maxRetries})` : '';
                
                logger.debug(`🔍 开始交易分类${attemptSuffix}`, {
                    trader: trader.label,
                    asset,
                    fillSize,
                    fillSide,
                    oid: fill.oid,
                    attempt
                });

                // 获取交易前的持仓状态（如果有缓存的话）
                const beforePosition = await this.positionManager.getAssetPosition(trader.address, asset);
                
                // 计算等待时间：首次5秒，重试时逐渐增加
                const waitTime = delayMs + (attempt * 3000); // 每次重试增加3秒
                
                if (waitTime > 0) {
                    logger.debug(`⏰ 等待交易结算 ${waitTime}ms${attemptSuffix}`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                }
                
                // 强制刷新获取交易后的持仓状态
                await this.positionManager.refreshUserPosition(trader.address);
                const afterPosition = await this.positionManager.getAssetPosition(trader.address, asset);
                
                // 分析持仓变化
                const changeAnalysis = await this.positionManager.comparePositionChange(
                    trader.address,
                    asset,
                    beforePosition
                );
                
                // 验证分析结果的合理性
                const validationResult = this.validateTradeClassification(
                    fill, 
                    beforePosition, 
                    afterPosition, 
                    changeAnalysis,
                    attempt
                );
                
                if (!validationResult.isValid) {
                    lastError = validationResult.reason || '未知验证错误';
                    
                    logger.warn(`⚠️ 交易分类验证失败${attemptSuffix}`, {
                        trader: trader.label,
                        asset,
                        reason: validationResult.reason,
                        attempt,
                        beforePosition,
                        afterPosition,
                        changeAnalysis: changeAnalysis.changeType,
                        fillSize,
                        fillSide
                    });
                    
                    // 如果还有重试机会，继续重试
                    if (attempt < maxRetries) {
                        attempt++;
                        logger.info(`🔄 准备重试交易分类`, {
                            trader: trader.label,
                            asset,
                            attempt,
                            nextWaitTime: delayMs + (attempt * 3000)
                        });
                        continue;
                    }
                    
                    // 所有重试都失败了，使用后备分类
                    logger.warn(`🔄 所有重试失败，使用后备分类`, {
                        trader: trader.label,
                        asset,
                        finalReason: lastError
                    });
                    return this.fallbackClassification(fill, trader, beforePosition, afterPosition);
                }
                
                // 验证成功，更新统计信息
                const currentCount = this.stats.classificationTypes.get(changeAnalysis.changeType) || 0;
                this.stats.classificationTypes.set(changeAnalysis.changeType, currentCount + 1);
                
                // 创建增强的交易事件
                const enhancedEvent = this.createEnhancedEvent(
                    fill,
                    trader,
                    changeAnalysis,
                    beforePosition,
                    afterPosition
                );
                
                logger.info(`✅ 交易分类完成${attemptSuffix}`, {
                    trader: trader.label,
                    asset,
                    type: changeAnalysis.changeType,
                    description: changeAnalysis.description,
                    notional: `$${(fillSize * price).toFixed(2)}`,
                    attempts: attempt + 1
                });
                
                return enhancedEvent;
                
            } catch (error) {
                this.stats.errors++;
                lastError = error instanceof Error ? error.message : String(error);
                const attemptSuffix = attempt > 0 ? ` (重试 ${attempt}/${maxRetries})` : '';
                
                logger.error(`❌ 交易分类异常${attemptSuffix}`, {
                    trader: trader.label,
                    asset: fill.coin,
                    error: lastError,
                    attempt
                });
                
                // 如果是最后一次尝试，返回后备分类
                if (attempt >= maxRetries) {
                    break;
                }
                
                attempt++;
                // 异常情况下也增加等待时间
                await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
            }
        }
        
        // 所有尝试都失败了，返回后备分类
        logger.warn(`🔄 所有分类尝试失败，使用后备分类`, {
            trader: trader.label,
            asset: fill.coin,
            finalError: lastError,
            totalAttempts: maxRetries + 1
        });
        
        return this.fallbackClassification(fill, trader);
    }

    /**
     * 验证交易分类结果的合理性 (增强版)
     */
    private validateTradeClassification(
        fill: any,
        beforePosition: AssetPosition | null,
        afterPosition: AssetPosition | null,
        changeAnalysis: PositionChangeAnalysis,
        attempt: number = 0
    ): ValidationResult {
        const fillSize = Math.abs(parseFloat(fill.sz || '0'));
        const fillSide = fill.side === 'B' ? 'long' : 'short';
        const tolerance = fillSize * 0.001; // 0.1% 容错范围
        
        // 如果是重试，使用更宽松的验证
        const isRetry = attempt > 0;
        
        logger.debug(`🔍 验证交易分类`, {
            changeType: changeAnalysis.changeType,
            fillSize,
            fillSide,
            beforeSize: beforePosition?.size || 0,
            afterSize: afterPosition?.size || 0,
            sizeChange: changeAnalysis.sizeChange,
            attempt,
            tolerance
        });
        
        // 检查基本逻辑一致性
        if (changeAnalysis.changeType === 'NO_CHANGE') {
            // 如果检测到NO_CHANGE但有实际交易，这可能是合理的情况：
            // 1. 同时有其他交易发生
            // 2. API延迟导致状态未及时更新
            // 3. 浮点数精度问题
            
            if (isRetry) {
                // 重试时更宽容，允许一些异常情况
                logger.debug(`🔄 重试验证：检测到NO_CHANGE但有交易，宽容处理`, {
                    fillSize,
                    beforePosition,
                    afterPosition
                });
                return { isValid: true, reason: '重试时宽容验证通过' };
            }
            
            // 首次验证时，如果有明显的交易但无变化，标记为需要重试
            if (fillSize > tolerance) {
                return {
                    isValid: false,
                    reason: `检测到交易 (${fillSize}) 但持仓无变化，需要重试`
                };
            }
        }
        
        // 检查开仓逻辑 - 更宽松的验证
        if (changeAnalysis.changeType.includes('OPEN')) {
            if (beforePosition && beforePosition.size > tolerance) {
                // 如果是重试，可能是合理的（例如部分平仓后再开仓）
                if (isRetry) {
                    logger.debug(`🔄 重试验证：已有持仓但标记为开仓，可能是复杂交易场景`);
                    return { isValid: true, reason: '重试时允许复杂开仓场景' };
                }
                
                return {
                    isValid: false,
                    reason: `已有持仓 (${beforePosition.size}) 但检测为开仓`
                };
            }
        }
        
        // 检查平仓逻辑 - 更宽松的验证
        if (changeAnalysis.changeType === 'CLOSE_POSITION') {
            if (!beforePosition || beforePosition.size <= tolerance) {
                if (isRetry) {
                    logger.debug(`🔄 重试验证：无持仓但标记为平仓，可能是时序问题`);
                    return { isValid: true, reason: '重试时允许时序异常' };
                }
                
                return {
                    isValid: false,
                    reason: `无持仓但检测为平仓`
                };
            }
            
            if (afterPosition && afterPosition.size > tolerance) {
                if (isRetry) {
                    logger.debug(`🔄 重试验证：平仓后仍有持仓，可能是部分平仓`);
                    return { isValid: true, reason: '重试时允许部分平仓' };
                }
                
                return {
                    isValid: false,
                    reason: `平仓后仍有持仓 (${afterPosition.size})`
                };
            }
        }
        
        // 检查持仓大小变化的合理性 - 使用容错范围
        const expectedSizeChange = Math.abs(changeAnalysis.sizeChange);
        if (expectedSizeChange > tolerance) {
            const sizeDifference = Math.abs(expectedSizeChange - fillSize);
            const maxAllowedDifference = isRetry ? fillSize * 0.5 : fillSize * 0.1; // 重试时允许更大差异
            
            if (sizeDifference > maxAllowedDifference) {
                logger.debug(`🔍 持仓变化与交易大小差异较大`, {
                    fillSize,
                    sizeChange: expectedSizeChange,
                    difference: sizeDifference,
                    maxAllowed: maxAllowedDifference,
                    isRetry
                });
                
                if (!isRetry) {
                    return {
                        isValid: false,
                        reason: `持仓变化 (${expectedSizeChange}) 与交易大小 (${fillSize}) 差异过大`
                    };
                }
            }
        }
        
        logger.debug(`✅ 交易分类验证通过`, {
            changeType: changeAnalysis.changeType,
            attempt,
            reason: isRetry ? '重试验证通过' : '首次验证通过'
        });
        
        return { 
            isValid: true, 
            reason: isRetry ? '重试验证通过' : '首次验证通过'
        };
    }

    /**
     * 后备分类方法 - 基于简单逻辑
     */
    private fallbackClassification(
        fill: any,
        trader: ContractTrader,
        beforePosition?: AssetPosition | null,
        afterPosition?: AssetPosition | null
    ): EnhancedContractEvent {
        const fillSide = fill.side === 'B' ? 'long' : 'short';
        let eventType: ContractEvent['eventType'];
        let description: string;
        
        // 使用简单的后备逻辑
        if (!beforePosition || beforePosition.size === 0) {
            eventType = fillSide === 'long' ? 'position_open_long' : 'position_open_short';
            description = `${fillSide === 'long' ? '开多仓' : '开空仓'} (后备分类)`;
        } else if (beforePosition.side === fillSide) {
            eventType = 'position_increase';
            description = `加仓 (后备分类)`;
        } else {
            eventType = 'position_close';
            description = `平仓 (后备分类)`;
        }
        
        logger.warn(`🔄 使用后备交易分类`, {
            trader: trader.label,
            asset: fill.coin,
            type: eventType,
            reason: '主要分类方法失败'
        });
        
        return this.createBasicEnhancedEvent(fill, trader, eventType, description);
    }

    /**
     * 创建增强的交易事件
     */
    private createEnhancedEvent(
        fill: any,
        trader: ContractTrader,
        changeAnalysis: PositionChangeAnalysis,
        beforePosition: AssetPosition | null,
        afterPosition: AssetPosition | null
    ): EnhancedContractEvent {
        const fillSize = Math.abs(parseFloat(fill.sz || '0'));
        const price = parseFloat(fill.px || '0');
        const fillSide = fill.side === 'B' ? 'long' : 'short';
        
        // 映射内部类型到外部事件类型
        const eventTypeMapping: Record<PositionChangeType, ContractEvent['eventType']> = {
            'OPEN_LONG': 'position_open_long',
            'OPEN_SHORT': 'position_open_short',
            'CLOSE_POSITION': 'position_close',
            'INCREASE_POSITION': 'position_increase',
            'DECREASE_POSITION': 'position_decrease',
            'REVERSE_POSITION': 'position_reverse',
            'NO_CHANGE': 'no_change'
        };
        
        const eventType = eventTypeMapping[changeAnalysis.changeType] || 'unknown';
        
        let blockTime: number;
        if (fill.time) {
            blockTime = fill.time > 1e12 ? Math.floor(fill.time / 1000) : Math.floor(fill.time);
        } else {
            blockTime = Math.floor(Date.now() / 1000);
        }
        
        return {
            timestamp: Date.now(),
            address: trader.address,
            eventType,
            asset: fill.coin,
            size: fillSize.toString(),
            price: price.toString(),
            side: fillSide,
            hash: fill.hash || fill.tid || `classified_${Date.now()}_${fill.coin}`,
            blockTime,
            
            // 增强字段
            classification: {
                type: changeAnalysis.changeType,
                description: changeAnalysis.description,
                confidence: 'high'
            },
            positionBefore: beforePosition,
            positionAfter: afterPosition,
            positionChange: {
                sizeChange: changeAnalysis.sizeChange,
                sideChanged: changeAnalysis.sideChanged
            },
            
            metadata: {
                notionalValue: (fillSize * price).toString(),
                originalAsset: fill.coin,
                traderLabel: trader.label,
                monitoredAddress: trader.address,
                actualFillUser: (fill as any).user,
                oid: fill.oid,
                crossed: fill.crossed,
                source: 'enhanced-classification',
                isRealTime: false,
                fillType: fill.side,
                originalFill: fill,
                
                // 分类特定的元数据
                classificationTimestamp: Date.now(),
                beforePositionSize: beforePosition?.size || 0,
                afterPositionSize: afterPosition?.size || 0
            }
        };
    }

    /**
     * 创建基础增强事件（后备方案）
     */
    private createBasicEnhancedEvent(
        fill: any,
        trader: ContractTrader,
        eventType: ContractEvent['eventType'],
        description: string,
        confidence: 'high' | 'medium' | 'low' = 'low'
    ): EnhancedContractEvent {
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
            eventType,
            asset: fill.coin,
            size: fillSize.toString(),
            price: price.toString(),
            side: fillSide,
            hash: fill.hash || fill.tid || `fallback_${Date.now()}_${fill.coin}`,
            blockTime,
            
            classification: {
                type: 'FALLBACK',
                description,
                confidence
            },
            
            metadata: {
                notionalValue: (fillSize * price).toString(),
                originalAsset: fill.coin,
                traderLabel: trader.label,
                monitoredAddress: trader.address,
                oid: fill.oid,
                crossed: fill.crossed,
                source: 'fallback-classification',
                isRealTime: false,
                fillType: fill.side,
                originalFill: fill
            }
        };
    }

    /**
     * 获取统计信息
     */
    getStats() {
        const classificationBreakdown: Record<string, number> = {};
        for (const [type, count] of this.stats.classificationTypes.entries()) {
            classificationBreakdown[type] = count;
        }
        
        return {
            ...this.stats,
            classificationBreakdown,
            successRate: this.stats.totalClassifications > 0 
                ? Math.round(((this.stats.totalClassifications - this.stats.errors) / this.stats.totalClassifications) * 100)
                : 0
        };
    }

    /**
     * 重置统计信息
     */
    resetStats(): void {
        this.stats = {
            totalClassifications: 0,
            classificationTypes: new Map(),
            errors: 0
        };
    }
}

// 类型定义
interface ValidationResult {
    isValid: boolean;
    reason?: string;
}

export interface EnhancedContractEvent extends ContractEvent {
    classification: {
        type: PositionChangeType | 'UNKNOWN' | 'FALLBACK';
        description: string;
        confidence: 'high' | 'medium' | 'low';
    };
    positionBefore?: AssetPosition | null;
    positionAfter?: AssetPosition | null;
    positionChange?: {
        sizeChange: number;
        sideChanged: boolean;
    };
}

export default TradeClassificationEngine;