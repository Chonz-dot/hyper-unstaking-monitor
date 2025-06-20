import * as hl from '@nktkas/hyperliquid';
import logger from '../src/logger';
import config from '../src/config';

async function testHyperliquidHTTPMonitoring() {
  console.log('📡 开始测试Hyperliquid HTTP API监控方案...\n');

  const httpTransport = new hl.HttpTransport();
  const infoClient = new hl.InfoClient({ transport: httpTransport });

  try {
    // 1. 获取市场元数据和HYPE资产信息
    console.log('1️⃣ 获取市场元数据');
    const meta = await infoClient.meta();
    console.log(`✅ 成功获取 ${meta.universe.length} 个资产信息`);

    // 查找HYPE相关资产
    const hypeAssets = meta.universe.filter(asset => 
      asset.name.toLowerCase().includes('hype')
    );
    
    console.log('\n📋 HYPE相关资产:');
    hypeAssets.forEach(asset => {
      console.log(`   ${asset.name}: 索引${asset.index}, 小数点${asset.szDecimals}`);
    });

    // 2. 测试用户账户状态查询
    console.log('\n2️⃣ 测试用户账户状态查询');
    const testAddress = config.monitoring.addresses[0];
    console.log(`   测试地址: ${testAddress.label} (${testAddress.address})`);

    try {
      // 获取用户的清算所状态
      const clearinghouseState = await infoClient.clearinghouseState({
        user: testAddress.address as `0x${string}`
      });
      
      console.log('✅ 成功获取账户状态');
      console.log(`   账户余额信息:`, {
        marginSummary: clearinghouseState.marginSummary,
        withdrawable: clearinghouseState.withdrawable,
      });

      // 获取用户持仓
      if (clearinghouseState.assetPositions.length > 0) {
        console.log('   当前持仓:');
        clearinghouseState.assetPositions.forEach(pos => {
          console.log(`     资产${pos.position.coin}: ${pos.position.szi} (未实现PnL: ${pos.position.unrealizedPnl})`);
        });
      } else {
        console.log('   无当前持仓');
      }

    } catch (userError) {
      console.log('⚠️  该地址可能无活动或API限制:', userError.message);
    }

    // 3. 测试历史交易查询
    console.log('\n3️⃣ 测试历史交易查询');
    try {
      const userFills = await infoClient.userFills({
        user: testAddress.address as `0x${string}`,
      });
      
      console.log(`✅ 成功获取交易历史: ${userFills.length} 条记录`);
      
      if (userFills.length > 0) {
        console.log('   最近交易样本:');
        userFills.slice(0, 3).forEach((fill, i) => {
          console.log(`     ${i + 1}. ${fill.coin} ${fill.side} ${fill.sz} @ ${fill.px} (时间: ${new Date(fill.time).toLocaleString()})`);
        });
      }

    } catch (fillsError) {
      console.log('⚠️  无法获取交易历史:', fillsError.message);
    }

    // 4. 测试账本更新查询
    console.log('\n4️⃣ 测试账本更新查询');
    try {
      const ledgerUpdates = await infoClient.userNonFundingLedgerUpdates({
        user: testAddress.address as `0x${string}`,
      });
      
      console.log(`✅ 成功获取账本更新: ${ledgerUpdates.length} 条记录`);
      
      if (ledgerUpdates.length > 0) {
        console.log('   最近账本更新样本:');
        ledgerUpdates.slice(0, 3).forEach((update, i) => {
          console.log(`     ${i + 1}. ${update.delta.type}: ${JSON.stringify(update.delta)}`);
        });
      }

    } catch (ledgerError) {
      console.log('⚠️  无法获取账本更新:', ledgerError.message);
    }

    // 5. 监控方案建议
    console.log('\n📋 基于HTTP API的监控方案:');
    console.log('   ✅ 优势:');
    console.log('     - API稳定可靠，无WebSocket兼容性问题');
    console.log('     - 可以获取完整的历史数据');
    console.log('     - 支持批量查询多个地址');
    console.log('   ⚠️  限制:');
    console.log('     - 需要轮询，不是真正实时');
    console.log('     - 可能有API调用频率限制');
    console.log('     - 延迟相对较高（秒级而非毫秒级）');

    console.log('\n💡 建议实现策略:');
    console.log('   1. 每10-30秒轮询一次用户状态');
    console.log('   2. 检查最新的账本更新和交易记录');
    console.log('   3. 对比上次检查的状态，识别新的转账');
    console.log('   4. 实现智能频率调整（活跃地址更频繁）');

    console.log('\n🎉 HTTP API监控方案测试完成！');

  } catch (error) {
    console.error('❌ HTTP API测试失败:', error);
    throw error;
  }
}

// 运行测试
testHyperliquidHTTPMonitoring().catch((error) => {
  console.error('❌ HTTP监控测试失败:', error);
  process.exit(1);
});
