import config from '../config';
import { PureRpcContractMonitor } from '../services/pureRpcContractMonitor';
import logger from '../logger';

/**
 * 测试修复后的交易分类系统
 */
async function testFixedClassification() {
    console.log('🔧 测试修复后的交易分类系统...\n');
    
    try {
        const monitor = new PureRpcContractMonitor(
            config.contractMonitoring.traders,
            1  // 设置为1美元，确保能捕获测试交易
        );
        
        // 监听事件，查看修复效果
        monitor.on('contractEvent', (event, trader) => {
            console.log('\n🎯 捕获到交易事件:');
            console.log('基础信息:', {
                trader: trader.label,
                asset: event.asset,
                eventType: event.eventType,
                size: event.size,
                price: event.price,
                notional: event.metadata?.notionalValue
            });
            
            if ('classification' in event) {
                const enhancedEvent = event as any;
                console.log('🏷️ 分类信息:', {
                    type: enhancedEvent.classification.type,
                    description: enhancedEvent.classification.description,
                    confidence: enhancedEvent.classification.confidence
                });
                
                console.log('📊 持仓信息:', {
                    positionBefore: enhancedEvent.positionBefore,
                    positionAfter: enhancedEvent.positionAfter,
                    positionChange: enhancedEvent.positionChange
                });
            }
        });
        
        console.log('🚀 启动监控器 (运行60秒，监听实际交易)...');
        await monitor.start();
        
        console.log('✅ 监控器已启动，等待交易事件...');
        console.log('💡 提示：现在可以执行一些测试交易来验证修复效果');
        
        // 运行60秒
        await new Promise(resolve => setTimeout(resolve, 60000));
        
        console.log('\n📊 监控结束，最终统计:');
        const stats = monitor.getStats();
        console.log('监控器统计:', stats.stats);
        console.log('增强功能统计:', stats.enhancedFeatures);
        
        await monitor.stop();
        console.log('\n✅ 测试完成!');
        
    } catch (error) {
        console.error('❌ 测试失败:', error);
        process.exit(1);
    }
}

if (require.main === module) {
    testFixedClassification()
        .then(() => {
            console.log('\n🎉 修复验证完成!');
            process.exit(0);
        })
        .catch(error => {
            console.error('\n💥 测试失败:', error);
            process.exit(1);
        });
}

export default testFixedClassification;