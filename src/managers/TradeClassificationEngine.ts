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

                // 获取交易前的持仓状态
                let beforePosition: AssetPosition | null = null;
                
                // 🔍 调试日志：记录查询时机
                const queryStartTime = Date.now();
                logger.info(`🔍 [调试] 开始查询持仓状态${attemptSuffix}`, {
                    trader: trader.label,
                    asset,
                    fillTime: new Date(fill.time).toISOString(),
                    queryTime: new Date(queryStartTime).toISOString(),
                    timeDiff: `${queryStartTime - fill.time}ms after fill`,
                    attempt
                });
                
                // 尝试从缓存获取历史持仓，而不是当前持仓
                try {
                    const cachedPosition = await this.positionManager.getAssetPosition(trader.address, asset);
                    beforePosition = cachedPosition;
                    
                    // 🔍 调试日志：缓存持仓状态
                    logger.info(`🔍 [调试] 获取到缓存持仓${attemptSuffix}`, {
                        trader: trader.label,
                        asset,
                        cachedPosition: cachedPosition ? {
                            size: cachedPosition.size,
                            side: cachedPosition.side,
                            entryPrice: cachedPosition.entryPrice,
                            unrealizedPnl: cachedPosition.unrealizedPnl
                        } : null,
                        isCacheEmpty: !cachedPosition
                    });
                } catch (error) {
                    logger.debug(`无法获取缓存持仓，将在交易后推算`, { trader: trader.label, asset });
                }
                
                // 计算等待时间：首次5秒，重试时逐渐增加
                const waitTime = delayMs + (attempt * 3000); // 每次重试增加3秒
                
                if (waitTime > 0) {
                    logger.info(`⏰ [调试] 等待交易结算 ${waitTime}ms${attemptSuffix}`, {
                        trader: trader.label,
                        asset,
                        waitReason: '让API数据更新，获取准确的交易后持仓'
                    });
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                }
                
                // 强制刷新获取交易后的持仓状态
                const refreshStartTime = Date.now();
                await this.positionManager.refreshUserPosition(trader.address);
                const afterPosition = await this.positionManager.getAssetPosition(trader.address, asset);
                
                // 🔍 调试日志：交易后持仓状态
                logger.info(`🔍 [调试] 获取交易后持仓${attemptSuffix}`, {
                    trader: trader.label,
                    asset,
                    refreshTime: new Date(refreshStartTime).toISOString(),
                    afterPosition: afterPosition ? {
                        size: afterPosition.size,
                        side: afterPosition.side,
                        entryPrice: afterPosition.entryPrice,
                        unrealizedPnl: afterPosition.unrealizedPnl
                    } : null,
                    isAfterEmpty: !afterPosition
                });
                
                // 如果之前没有获取到 beforePosition，尝试根据交易推算
                if (!beforePosition && afterPosition) {
                    beforePosition = this.estimateBeforePosition(afterPosition, fill);
                    logger.info(`📊 [调试] 推算交易前持仓${attemptSuffix}`, {
                        trader: trader.label,
                        asset,
                        estimatedBefore: beforePosition ? {
                            size: beforePosition.size,
                            side: beforePosition.side,
                            entryPrice: beforePosition.entryPrice,
                            unrealizedPnl: beforePosition.unrealizedPnl
                        } : null,
                        actualAfter: afterPosition ? {
                            size: afterPosition.size,
                            side: afterPosition.side,
                            entryPrice: afterPosition.entryPrice,
                            unrealizedPnl: afterPosition.unrealizedPnl
                        } : null,
                        fillSize,
                        fillSide
                    });
                }
                
                // 🔍 调试日志：对比前后持仓
                logger.info(`🔍 [调试] 持仓状态对比${attemptSuffix}`, {
                    trader: trader.label,
                    asset,
                    before: beforePosition ? {
                        size: beforePosition.size,
                        side: beforePosition.side,
                        hasPosition: beforePosition.size !== 0
                    } : null,
                    after: afterPosition ? {
                        size: afterPosition.size,
                        side: afterPosition.side,
                        hasPosition: afterPosition.size !== 0
                    } : null,
                    fillInfo: {
                        size: fillSize,
                        side: fillSide,
                        oid: fill.oid
                    }
                });
                
                // 分析持仓变化
                const changeAnalysis = await this.positionManager.comparePositionChange(
                    trader.address,
                    asset,
                    beforePosition
                );
                
                // 🔍 调试日志：持仓变化分析结果
                logger.info(`🔍 [调试] 持仓变化分析${attemptSuffix}`, {
                    trader: trader.label,
                    asset,
                    changeType: changeAnalysis.changeType,
                    sizeChange: changeAnalysis.sizeChange,
                    sideChanged: changeAnalysis.sideChanged,
                    description: changeAnalysis.description,
                    isNoChange: changeAnalysis.changeType === 'NO_CHANGE',
                    fillSize,
                    fillSide
                });
                
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
                    
                    // 所有重试都失败了，使用特征分析方法
                    logger.info(`🧠 使用交易特征分析方法`, {
                        trader: trader.label,
                        asset,
                        finalReason: lastError
                    });
                    
                    const featureClassification = this.classifyByTradeCharacteristics(fill, beforePosition, afterPosition);
                    const enhancedEvent = this.createEnhancedEventFromFeatures(
                        fill,
                        trader,
                        featureClassification,
                        beforePosition,
                        afterPosition
                    );
                    
                    logger.info(`✅ 特征分析分类完成`, {
                        trader: trader.label,
                        asset,
                        type: featureClassification.eventType,
                        description: featureClassification.description,
                        confidence: featureClassification.confidence,
                        notional: `$${(fillSize * price).toFixed(2)}`
                    });
                    
                    return enhancedEvent;
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
     * 根据交易后持仓推算交易前持仓
     */
    private estimateBeforePosition(afterPosition: AssetPosition, fill: any): AssetPosition | null {
        const fillSize = parseFloat(fill.sz || '0');
        const fillSide = fill.side === 'B' ? 'long' : 'short';
        
        logger.debug('📊 推算交易前持仓', {
            fillSize,
            fillSide,
            afterSize: afterPosition.size,
            afterSide: afterPosition.side
        });
        
        // 如果交易后无持仓，说明这是平仓操作
        if (afterPosition.size === 0) {
            // 卖出(B=false)平多仓，买入(B=true)平空仓
            const beforeSide = fillSide === 'short' ? 'long' : 'short';
            
            return {
                asset: afterPosition.asset,
                size: Math.abs(fillSize),
                side: beforeSide,
                entryPrice: parseFloat(fill.px || '0'),
                unrealizedPnl: 0,
                notionalValue: Math.abs(fillSize) * parseFloat(fill.px || '0')
            };
        }
        
        // 根据交易方向推算
        if (afterPosition.side === fillSide) {
            // 同方向，说明是加仓操作
            const beforeSize = Math.max(0, afterPosition.size - Math.abs(fillSize));
            return {
                asset: afterPosition.asset,
                size: beforeSize,
                side: afterPosition.side,
                entryPrice: afterPosition.entryPrice,
                unrealizedPnl: afterPosition.unrealizedPnl,
                notionalValue: beforeSize * afterPosition.entryPrice
            };
        } else {
            // 反方向交易，可能是从反向仓位转换而来
            // 这种情况比较复杂，保守估计
            return {
                asset: afterPosition.asset,
                size: Math.abs(fillSize),
                side: fillSide === 'long' ? 'short' : 'long',
                entryPrice: parseFloat(fill.px || '0'),
                unrealizedPnl: 0,
                notionalValue: Math.abs(fillSize) * parseFloat(fill.px || '0')
            };
        }
    }

    /**
     * 基于交易特征的智能分类（新方法）
     */
    private classifyByTradeCharacteristics(
        fill: any, 
        beforePosition: AssetPosition | null, 
        afterPosition: AssetPosition | null
    ): { eventType: ContractEvent['eventType'], description: string, confidence: 'high' | 'medium' | 'low' } {
        const fillSize = Math.abs(parseFloat(fill.sz || '0'));
        const fillSide = fill.side === 'B' ? 'long' : 'short';
        const isCrossed = fill.crossed; // true = 吃单, false = 挂单
        
        logger.debug(`🧠 基于交易特征分类`, {
            fillSize,
            fillSide,
            isCrossed,
            beforeSize: beforePosition?.size || 0,
            afterSize: afterPosition?.size || 0,
            beforeSide: beforePosition?.side || 'none',
            afterSide: afterPosition?.side || 'none'
        });
        
        // 策略1: 如果持仓真的发生了变化，使用持仓变化逻辑
        if (beforePosition && afterPosition) {
            const sizeChange = afterPosition.size - beforePosition.size;
            const sideChanged = beforePosition.side !== afterPosition.side;
            
            if (Math.abs(sizeChange) > fillSize * 0.1 || sideChanged) {
                // 有明显持仓变化，使用传统逻辑
                if (beforePosition.size === 0) {
                    return {
                        eventType: fillSide === 'long' ? 'position_open_long' : 'position_open_short',
                        description: `${fillSide === 'long' ? '开多仓' : '开空仓'}`,
                        confidence: 'high'
                    };
                } else if (afterPosition.size === 0) {
                    return {
                        eventType: 'position_close',
                        description: '平仓',
                        confidence: 'high'
                    };
                } else if (sideChanged) {
                    return {
                        eventType: 'position_reverse',
                        description: `反向操作 (${beforePosition.side} → ${afterPosition.side})`,
                        confidence: 'medium'
                    };
                } else if (sizeChange > 0) {
                    return {
                        eventType: 'position_increase',
                        description: '加仓',
                        confidence: 'medium'
                    };
                } else {
                    return {
                        eventType: 'position_decrease',
                        description: '减仓',
                        confidence: 'medium'
                    };
                }
            }
        }
        
        // 策略2: 持仓没变化，基于交易特征推断
        if (!beforePosition || beforePosition.size === 0) {
            // 之前无持仓，这应该是开仓
            return {
                eventType: fillSide === 'long' ? 'position_open_long' : 'position_open_short',
                description: `${fillSide === 'long' ? '开多仓' : '开空仓'} (特征分析)`,
                confidence: 'high'
            };
        }
        
        // 策略3: 检查是否是平仓操作 - 关键修复
        if (afterPosition && afterPosition.size === 0 && fillSize > 0) {
            // 有交易但最终无持仓，很可能是平仓
            return {
                eventType: 'position_close',
                description: '平仓操作',
                confidence: 'high'
            };
        }
        
        // 策略4: 检查是否是减仓平仓（部分平仓）
        if (beforePosition && afterPosition && 
            beforePosition.size > afterPosition.size && 
            beforePosition.side === afterPosition.side) {
            const sizeReduction = beforePosition.size - afterPosition.size;
            if (Math.abs(sizeReduction - fillSize) < fillSize * 0.1) {
                return {
                    eventType: 'position_decrease',
                    description: '减仓',
                    confidence: 'high'
                };
            }
        }
        
        // 策略4: 有持仓但没变化 - 可能是对冲交易
        if (beforePosition.side === fillSide) {
            // 同方向交易，可能是加仓
            return {
                eventType: 'position_increase',
                description: `加${fillSide}仓 (可能对冲)`,
                confidence: 'low'
            };
        } else {
            // 反方向交易，可能是平仓
            return {
                eventType: 'position_decrease',
                description: `减${beforePosition.side}仓 (可能对冲)`,
                confidence: 'low'
            };
        }
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
            // 如果检测到NO_CHANGE但有实际交易，可能的合理情况：
            const fillSizeSignificant = fillSize > tolerance;
            
            if (!isRetry && fillSizeSignificant) {
                // 首次检测，如果交易金额显著，需要重试
                return {
                    isValid: false,
                    reason: `检测到交易 (${fillSize}) 但持仓无变化，需要重试`
                };
            }
            
            // 重试时或小额交易，使用智能分类
            if (fillSizeSignificant) {
                logger.warn(`🤔 NO_CHANGE但有显著交易，可能是复杂场景`, {
                    fillSize,
                    beforeSize: beforePosition?.size || 0,
                    afterSize: afterPosition?.size || 0,
                    isRetry
                });
                
                // 强制使用后备分类而不是标记为失败
                return { 
                    isValid: true, 
                    reason: '复杂交易场景，使用智能分类'
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
     * 基于特征分析创建增强事件
     */
    private createEnhancedEventFromFeatures(
        fill: any,
        trader: ContractTrader,
        classification: { eventType: ContractEvent['eventType'], description: string, confidence: 'high' | 'medium' | 'low' },
        beforePosition: AssetPosition | null,
        afterPosition: AssetPosition | null
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
            eventType: classification.eventType,
            asset: fill.coin,
            size: fillSize.toString(),
            price: price.toString(),
            side: fillSide,
            hash: fill.hash || fill.tid || `feature_${Date.now()}_${fill.coin}`,
            blockTime,
            
            // 增强字段
            classification: {
                type: this.mapEventTypeToClassificationType(classification.eventType),
                description: classification.description,
                confidence: classification.confidence
            },
            positionBefore: beforePosition,
            positionAfter: afterPosition,
            positionChange: {
                sizeChange: afterPosition && beforePosition ? afterPosition.size - beforePosition.size : 0,
                sideChanged: afterPosition && beforePosition ? afterPosition.side !== beforePosition.side : false
            },
            
            metadata: {
                notionalValue: (fillSize * price).toString(),
                originalAsset: fill.coin,
                traderLabel: trader.label,
                monitoredAddress: trader.address,
                actualFillUser: (fill as any).user,
                oid: fill.oid,
                crossed: fill.crossed,
                source: 'feature-analysis',
                isRealTime: false,
                fillType: fill.side,
                originalFill: fill,
                
                // 特征分析特定的元数据
                analysisMethod: 'trade-characteristics',
                featureConfidence: classification.confidence
            }
        };
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
     * 映射事件类型到分类类型
     */
    private mapEventTypeToClassificationType(eventType: string): PositionChangeType | 'UNKNOWN' | 'FALLBACK' {
        const mapping: Record<string, PositionChangeType> = {
            'position_open_long': 'OPEN_LONG',
            'position_open_short': 'OPEN_SHORT',
            'position_close': 'CLOSE_POSITION',
            'position_increase': 'INCREASE_POSITION',
            'position_decrease': 'DECREASE_POSITION',
            'position_reverse': 'REVERSE_POSITION'
        };
        
        return mapping[eventType] || 'UNKNOWN';
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