import config from '../config';
import { PureRpcContractMonitor } from '../services/pureRpcContractMonitor';
import logger from '../logger';

/**
 * 测试增强版合约监控器
 */
async function testEnhancedMonitor() {
    console.log('🧪 开始测试增强版合约监控器...\n');
    
    try {
        // 创建监控器实例
        const monitor = new PureRpcContractMonitor(
            config.contractMonitoring.traders,
            config.contractMonitoring.minNotionalValue || 100
        );
        
        console.log('📊 监控器初始化统计:');
        console.log(monitor.getStats());
        
        console.log('\n📋 监控器状态:');
        console.log(monitor.getStatus());
        
        // 监听合约事件
        monitor.on('contractEvent', (event, trader) => {
            console.log('\n🚨 收到增强合约事件:');
            console.log('📊 基础信息:', {
                trader: trader.label,
                asset: event.asset,
                eventType: event.eventType,
                size: event.size,
                price: event.price,
                side: event.side,
                notional: event.metadata?.notionalValue
            });
            
            // 检查是否是增强事件
            if ('classification' in event) {
                const enhancedEvent = event as any;
                console.log('🏷️ 增强分类信息:', {
                    type: enhancedEvent.classification.type,
                    description: enhancedEvent.classification.description,
                    confidence: enhancedEvent.classification.confidence
                });
                
                if (enhancedEvent.positionBefore) {
                    console.log('📋 持仓变化:', {
                        before: enhancedEvent.positionBefore,
                        after: enhancedEvent.positionAfter,
                        change: enhancedEvent.positionChange
                    });
                }
            }
        });
        
        console.log('\n🚀 启动监控器 (运行30秒)...');
        await monitor.start();
        
        // 运行30秒
        await new Promise(resolve => setTimeout(resolve, 30000));
        
        console.log('\n📊 监控运行结果:');
        console.log(monitor.getStats());
        
        console.log('\n⏹️ 停止监控器...');
        await monitor.stop();
        
        console.log('\n✅ 增强版监控器测试完成!');
        
    } catch (error) {
        console.error('❌ 测试失败:', error);
        process.exit(1);
    }
}

// 运行测试
if (require.main === module) {
    testEnhancedMonitor()
        .then(() => {
            console.log('\n🎉 监控器测试完成!');
            process.exit(0);
        })
        .catch(error => {
            console.error('\n💥 测试失败:', error);
            process.exit(1);
        });
}

export default testEnhancedMonitor;