import config from '../config';
import { PureRpcContractMonitor } from '../services/pureRpcContractMonitor';
import logger from '../logger';

/**
 * 测试交易类型分类修复
 */
async function testTradeTypeClassification() {
    console.log('🔧 测试交易类型分类修复...\n');
    
    let eventCount = 0;
    const eventTypes = new Map<string, number>();
    const classificationTypes = new Map<string, number>();
    
    try {
        const monitor = new PureRpcContractMonitor(
            config.contractMonitoring.traders,
            1  // 极低阈值
        );
        
        // 监听事件，统计分类结果
        monitor.on('contractEvent', (alert, trader) => {
            eventCount++;
            
            // 统计告警类型
            const alertType = alert.alertType || 'unknown';
            eventTypes.set(alertType, (eventTypes.get(alertType) || 0) + 1);
            
            // 统计分类类型
            if (alert.classification) {
                const classType = alert.classification.type;
                classificationTypes.set(classType, (classificationTypes.get(classType) || 0) + 1);
            }
            
            console.log(`\n🎯 事件 #${eventCount}:`);
            console.log(`  交易员: ${trader.label}`);
            console.log(`  资产: ${alert.asset}`);
            console.log(`  告警类型: ${alertType} ${getTypeEmoji(alertType)}`);
            console.log(`  大小: ${alert.size}`);
            console.log(`  价格: $${alert.price}`);
            console.log(`  价值: $${alert.notionalValue || 'N/A'}`);
            
            if (alert.classification) {
                console.log(`  分类: ${alert.classification.type} (${alert.classification.confidence})`);
                console.log(`  描述: ${alert.classification.description}`);
            }
            
            if (alert.positionChange) {
                console.log(`  持仓变化: ${alert.positionChange.sizeChange} (方向变化: ${alert.positionChange.sideChanged})`);
            }
            
            console.log(`  增强: ${alert.enhanced ? '✅' : '❌'}`);
        });
        
        console.log('🚀 启动测试监控器...');
        await monitor.start();
        
        // 显示实时统计
        const showClassificationStats = () => {
            console.log('\n📊 分类统计:');
            console.log(`总事件数: ${eventCount}`);
            
            console.log('\n告警类型分布:');
            for (const [type, count] of eventTypes.entries()) {
                const percentage = eventCount > 0 ? ((count / eventCount) * 100).toFixed(1) : '0';
                console.log(`  ${type}: ${count} (${percentage}%) ${getTypeEmoji(type)}`);
            }
            
            console.log('\n分类类型分布:');
            for (const [type, count] of classificationTypes.entries()) {
                const percentage = eventCount > 0 ? ((count / eventCount) * 100).toFixed(1) : '0';
                console.log(`  ${type}: ${count} (${percentage}%)`);
            }
            
            // 检查问题
            const updateCount = eventTypes.get('position_update') || 0;
            const updatePercentage = eventCount > 0 ? ((updateCount / eventCount) * 100) : 0;
            
            if (updatePercentage > 80) {
                console.log(`\n⚠️ 警告: position_update 占比过高 (${updatePercentage.toFixed(1)}%)，可能仍有分类问题`);
            } else if (updatePercentage < 30) {
                console.log(`\n✅ 好消息: position_update 占比合理 (${updatePercentage.toFixed(1)}%)，分类已改善`);
            }
        };
        
        // 每30秒显示统计
        const statsInterval = setInterval(showClassificationStats, 30000);
        
        console.log('✅ 监控器已启动，等待交易事件...');
        console.log('🎯 观察交易类型分类是否改善...');
        
        // 运行90秒
        await new Promise(resolve => setTimeout(resolve, 90000));
        
        clearInterval(statsInterval);
        
        console.log('\n📊 最终分类报告:');
        showClassificationStats();
        
        await monitor.stop();
        console.log('\n✅ 测试完成!');
        
        // 评估结果
        const updatePercentage = eventCount > 0 ? ((eventTypes.get('position_update') || 0) / eventCount) * 100 : 0;
        
        if (updatePercentage > 80) {
            console.log('\n❌ 修复效果不佳: position_update 仍然占主导');
            console.log('💡 建议: 进一步优化交易特征分析逻辑');
        } else if (updatePercentage < 50) {
            console.log('\n✅ 修复效果良好: 交易类型分类明显改善');
            console.log('🎉 position_update 占比下降到合理范围');
        } else {
            console.log('\n🤔 修复效果一般: 还有改进空间');
        }
        
    } catch (error) {
        console.error('❌ 测试失败:', error);
        process.exit(1);
    }
}

// 辅助方法
function getTypeEmoji(type: string): string {
    const emojiMap: Record<string, string> = {
        'position_open_long': '🚀',
        'position_open_short': '🔻', 
        'position_close': '✅',
        'position_update': '🔄',
        'position_reverse': '↩️'
    };
    return emojiMap[type] || '❓';
}

if (require.main === module) {
    testTradeTypeClassification()
        .then(() => {
            console.log('\n🔬 交易类型分类测试完成');
            process.exit(0);
        })
        .catch(error => {
            console.error('\n💥 测试失败:', error);
            process.exit(1);
        });
}

export default testTradeTypeClassification;