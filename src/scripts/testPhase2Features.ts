import config from '../config';
import { PureRpcContractMonitor } from '../services/pureRpcContractMonitor';
import logger from '../logger';

/**
 * 测试 Phase 2: 持仓分析功能
 */
async function testPhase2Features() {
    console.log('🚀 测试 Phase 2: 持仓分析功能...\n');
    
    try {
        const monitor = new PureRpcContractMonitor(
            config.contractMonitoring.traders,
            100  // 降低阈值，更容易触发分析
        );
        
        console.log('📊 监控器初始化状态:');
        console.log(JSON.stringify(monitor.getStats(), null, 2));
        
        // 监听增强告警事件
        monitor.on('contractEvent', (alert, trader) => {
            console.log('\n🎯 收到增强告警事件:');
            
            // 基础信息
            console.log('📊 基础信息:', {
                trader: trader.label,
                asset: alert.asset,
                eventType: alert.alertType,
                size: alert.size,
                price: alert.price,
                notional: alert.notionalValue,
                enhanced: alert.enhanced,
                alertLevel: alert.alertLevel
            });
            
            // 分类信息
            if (alert.classification) {
                console.log('🏷️ 分类信息:', {
                    type: alert.classification.type,
                    description: alert.classification.description,
                    confidence: alert.classification.confidence
                });
            }
            
            // 显示格式化消息
            if (alert.formattedMessage) {
                console.log('\n📝 格式化告警消息:');
                console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                console.log(alert.formattedMessage);
                console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            }
        });
        
        console.log('\n🚀 启动增强监控器 (Phase 2)...');
        await monitor.start();
        
        console.log('✅ 监控器已启动，等待交易事件...');
        console.log('💡 提示：执行一些测试交易来查看增强告警效果');
        console.log('🎯 增强功能：交易分类 + 持仓分析 + 智能告警');
        
        // 显示实时统计
        const showStats = () => {
            console.log('\n📊 实时统计 (每30秒更新):');
            const stats = monitor.getStats();
            console.log('基础统计:', {
                requests: stats.stats.totalRequests,
                errors: stats.stats.totalErrors,
                events: stats.stats.totalEvents,
                successRate: stats.successRate + '%'
            });
            
            console.log('增强功能统计:', {
                positionManager: {
                    cacheHits: stats.enhancedFeatures.positionManager.cacheHits,
                    hitRate: stats.enhancedFeatures.positionManager.hitRate
                },
                classificationEngine: {
                    total: stats.enhancedFeatures.classificationEngine.totalClassifications,
                    errors: stats.enhancedFeatures.classificationEngine.errors
                },
                analysisEngine: {
                    totalAnalysis: stats.enhancedFeatures.analysisEngine.totalAnalysis,
                    avgTime: stats.enhancedFeatures.analysisEngine.averageAnalysisTime + 'ms'
                },
                alertSystem: {
                    totalAlerts: stats.enhancedFeatures.alertSystem.totalAlerts,
                    advancedRate: stats.enhancedFeatures.alertSystem.advancedRate + '%'
                }
            });
        };
        
        // 每30秒显示统计
        const statsInterval = setInterval(showStats, 30000);
        
        // 运行2分钟
        await new Promise(resolve => setTimeout(resolve, 120000));
        
        clearInterval(statsInterval);
        
        console.log('\n📊 最终统计报告:');
        showStats();
        
        await monitor.stop();
        console.log('\n✅ Phase 2 测试完成!');
        
    } catch (error) {
        console.error('❌ 测试失败:', error);
        process.exit(1);
    }
}

if (require.main === module) {
    testPhase2Features()
        .then(() => {
            console.log('\n🎉 Phase 2 功能测试完成!');
            console.log('🚀 系统现在具备完整的持仓分析和智能告警能力!');
            process.exit(0);
        })
        .catch(error => {
            console.error('\n💥 测试失败:', error);
            process.exit(1);
        });
}

export default testPhase2Features;