import config from '../config';
import { PureRpcContractMonitor } from '../services/pureRpcContractMonitor';
import logger from '../logger';

/**
 * 调试交易分类和增强告警
 */
async function debugEnhancedAlerts() {
    console.log('🔧 调试增强告警系统...\n');
    
    try {
        const monitor = new PureRpcContractMonitor(
            config.contractMonitoring.traders,
            1  // 极低阈值，确保捕获所有交易
        );
        
        // 监听事件，详细分析
        monitor.on('contractEvent', (alert, trader) => {
            console.log('\n🔍 详细事件分析:');
            console.log('==========================================');
            
            // 基础信息
            console.log('📊 基础信息:');
            console.log(`  交易员: ${trader.label}`);
            console.log(`  资产: ${alert.asset}`);
            console.log(`  告警类型: ${alert.alertType}`);
            console.log(`  事件类型: ${alert.eventType || 'N/A'}`);
            console.log(`  大小: ${alert.size}`);
            console.log(`  价格: ${alert.price}`);
            console.log(`  价值: ${alert.notionalValue || 'N/A'}`);
            console.log(`  增强: ${alert.enhanced}`);
            console.log(`  级别: ${alert.alertLevel}`);
            
            // 分类信息
            if (alert.classification) {
                console.log('\n🏷️ 分类信息:');
                console.log(`  类型: ${alert.classification.type}`);
                console.log(`  描述: ${alert.classification.description}`);
                console.log(`  置信度: ${alert.classification.confidence}`);
            }
            
            // 持仓变化
            if (alert.positionChange) {
                console.log('\n📈 持仓变化:');
                console.log(`  大小变化: ${alert.positionChange.sizeChange}`);
                console.log(`  方向变化: ${alert.positionChange.sideChanged}`);
            }
            
            // 增强分析（如果有）
            if (alert.enhanced && alert.formattedMessage) {
                console.log('\n📝 增强分析消息:');
                console.log('------------------------------------------');
                console.log(alert.formattedMessage);
                console.log('------------------------------------------');
            } else if (!alert.enhanced) {
                console.log('\n⚠️ 为什么没有增强分析？');
                console.log('可能原因：');
                console.log('  1. 交易金额低于阈值');
                console.log('  2. 不是开仓操作');
                console.log('  3. 超过频率限制');
                console.log('  4. 分析引擎出错');
            }
            
            console.log('==========================================\n');
        });
        
        console.log('🚀 启动调试监控器...');
        await monitor.start();
        
        // 显示系统状态
        const showDetailedStats = () => {
            console.log('\n📊 详细系统状态:');
            const stats = monitor.getStats();
            
            console.log('基础统计:', {
                运行中: stats.isRunning,
                策略: stats.strategy,
                交易员数: stats.traders,
                请求数: stats.stats.totalRequests,
                错误数: stats.stats.totalErrors,
                事件数: stats.stats.totalEvents,
                成功率: stats.successRate + '%'
            });
            
            console.log('\n持仓管理器:', {
                缓存命中: stats.enhancedFeatures.positionManager.cacheHits,
                缓存未命中: stats.enhancedFeatures.positionManager.cacheMisses,
                API调用: stats.enhancedFeatures.positionManager.apiCalls,
                错误: stats.enhancedFeatures.positionManager.errors,
                命中率: stats.enhancedFeatures.positionManager.hitRate
            });
            
            console.log('\n分类引擎:', {
                总分类: stats.enhancedFeatures.classificationEngine.totalClassifications,
                错误: stats.enhancedFeatures.classificationEngine.errors,
                成功率: stats.enhancedFeatures.classificationEngine.successRate + '%'
            });
            
            console.log('\n分析引擎:', {
                总分析: stats.enhancedFeatures.analysisEngine.totalAnalysis,
                平均时间: stats.enhancedFeatures.analysisEngine.averageAnalysisTime + 'ms',
                错误: stats.enhancedFeatures.analysisEngine.errors
            });
            
            console.log('\n告警系统:', {
                总告警: stats.enhancedFeatures.alertSystem.totalAlerts,
                增强告警: stats.enhancedFeatures.alertSystem.enhancedAlerts,
                基础告警: stats.enhancedFeatures.alertSystem.basicAlerts,
                跳过分析: stats.enhancedFeatures.alertSystem.analysisSkipped,
                增强率: stats.enhancedFeatures.alertSystem.enhancedRate + '%'
            });
        };
        
        // 每20秒显示详细统计
        const statsInterval = setInterval(showDetailedStats, 20000);
        
        console.log('✅ 监控器已启动，等待交易事件...');
        console.log('💡 当有交易时，会显示详细的分析过程');
        
        // 运行1分钟进行调试
        await new Promise(resolve => setTimeout(resolve, 60000));
        
        clearInterval(statsInterval);
        showDetailedStats();
        
        await monitor.stop();
        console.log('\n✅ 调试完成!');
        
    } catch (error) {
        console.error('❌ 调试失败:', error);
        process.exit(1);
    }
}

if (require.main === module) {
    debugEnhancedAlerts()
        .then(() => {
            console.log('\n🔍 调试会话结束');
            process.exit(0);
        })
        .catch(error => {
            console.error('\n💥 调试失败:', error);
            process.exit(1);
        });
}

export default debugEnhancedAlerts;