import * as hl from '@nktkas/hyperliquid';
import { PositionStateManager } from '../managers/PositionStateManager';
import { TradeClassificationEngine } from '../managers/TradeClassificationEngine';
import logger from '../logger';

/**
 * 测试交易分类系统
 */
async function testTradeClassification() {
    console.log('🧪 开始测试交易分类系统...\n');
    
    try {
        // 初始化组件
        const transport = new hl.HttpTransport({
            timeout: 15000,
            isTestnet: false
        });
        const infoClient = new hl.InfoClient({ transport });
        
        const positionManager = new PositionStateManager(infoClient);
        const classificationEngine = new TradeClassificationEngine(positionManager);
        
        // 测试地址 (使用配置中的测试地址)
        const testAddress = '0x45090576dEBb996eeFe85C1269E8772F8B08025A';
        const testTrader = {
            address: testAddress,
            label: 'test',
            isActive: true
        };
        
        console.log('📊 测试持仓状态管理器...');
        
        // 测试获取持仓状态
        const userPosition = await positionManager.getUserPosition(testAddress);
        if (userPosition) {
            console.log('✅ 成功获取用户持仓:', {
                address: userPosition.userAddress,
                positionsCount: userPosition.positions.length,
                totalValue: userPosition.totalNotionalValue,
                accountValue: userPosition.accountValue
            });
            
            // 显示具体持仓
            if (userPosition.positions.length > 0) {
                console.log('📋 当前持仓明细:');
                userPosition.positions.forEach((pos, index) => {
                    console.log(`  ${index + 1}. ${pos.asset}: ${pos.size} ${pos.side} @ $${pos.entryPrice} (PnL: ${pos.unrealizedPnl})`);
                });
            } else {
                console.log('📋 当前无持仓');
            }
        } else {
            console.log('❌ 获取用户持仓失败');
        }
        
        console.log('\n🔍 测试缓存功能...');
        
        // 测试缓存
        const start = Date.now();
        const cachedPosition = await positionManager.getUserPosition(testAddress);
        const cacheTime = Date.now() - start;
        console.log(`✅ 缓存命中时间: ${cacheTime}ms`);
        
        console.log('\n📈 测试特定资产持仓...');
        
        // 测试获取特定资产持仓
        const ethPosition = await positionManager.getAssetPosition(testAddress, 'ETH');
        if (ethPosition) {
            console.log('✅ ETH持仓:', {
                asset: ethPosition.asset,
                size: ethPosition.size,
                side: ethPosition.side,
                entryPrice: ethPosition.entryPrice,
                unrealizedPnl: ethPosition.unrealizedPnl
            });
        } else {
            console.log('📋 ETH无持仓');
        }
        
        console.log('\n🏷️ 测试交易分类引擎...');
        
        // 创建模拟交易数据
        const mockFill = {
            coin: 'ETH',
            sz: '0.1',
            px: '3800',
            side: 'B', // 买入
            oid: 12345,
            time: Date.now(),
            hash: 'test_hash_' + Date.now(),
            crossed: true
        };
        
        console.log('🎯 模拟交易:', {
            asset: mockFill.coin,
            size: mockFill.sz,
            side: mockFill.side === 'B' ? 'Buy' : 'Sell',
            price: mockFill.px,
            notional: (parseFloat(mockFill.sz) * parseFloat(mockFill.px)).toFixed(2)
        });
        
        // 注意: 这个测试不会实际执行交易，只是测试分类逻辑
        console.log('ℹ️ 注意: 这是模拟测试，不会执行实际交易');
        
        console.log('\n📊 组件统计信息:');
        console.log('📋 持仓管理器统计:', positionManager.getStats());
        console.log('🏷️ 分类引擎统计:', classificationEngine.getStats());
        
        console.log('\n✅ 交易分类系统测试完成!');
        
    } catch (error) {
        console.error('❌ 测试失败:', error);
        process.exit(1);
    }
}

// 运行测试
if (require.main === module) {
    testTradeClassification()
        .then(() => {
            console.log('\n🎉 所有测试通过!');
            process.exit(0);
        })
        .catch(error => {
            console.error('\n💥 测试失败:', error);
            process.exit(1);
        });
}

export default testTradeClassification;