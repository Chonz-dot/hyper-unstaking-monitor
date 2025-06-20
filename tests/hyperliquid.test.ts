import * as hl from '@nktkas/hyperliquid';
import logger from '../src/logger';
import config from '../src/config';

async function testHyperliquidWebSocket() {
  console.log('🌐 开始测试Hyperliquid WebSocket连接...\n');

  // 初始化WebSocket传输
  const transport = new hl.WebSocketTransport({
    url: config.hyperliquid.wsUrl,
    timeout: 10000,
    keepAlive: {
      interval: 30000,
      timeout: 10000,
    },
    reconnect: {
      maxRetries: 3,
      connectionTimeout: 10000,
      connectionDelay: (attempt: number) => Math.min(1000 * Math.pow(2, attempt), 10000),
    },
  });

  const client = new hl.SubscriptionClient({ transport });

  try {
    console.log('1️⃣ 建立WebSocket连接');
    await transport.ready();
    console.log('✅ WebSocket连接成功\n');

    // 测试一个地址的用户事件订阅
    const testAddress = config.monitoring.addresses[0].address as `0x${string}`;
    console.log(`2️⃣ 测试用户事件订阅: ${config.monitoring.addresses[0].label}`);
    console.log(`   地址: ${testAddress}\n`);

    // 用于收集数据样本
    const eventSamples: any[] = [];
    const ledgerSamples: any[] = [];
    const fillSamples: any[] = [];

    // 订阅用户事件
    const userEventsSub = await client.userEvents(
      { user: testAddress },
      (data) => {
        console.log('📨 收到用户事件:', JSON.stringify(data, null, 2));
        eventSamples.push(data);
      }
    );
    console.log('✅ 用户事件订阅成功');

    // 订阅账本更新
    const ledgerSub = await client.userNonFundingLedgerUpdates(
      { user: testAddress },
      (data) => {
        console.log('📊 收到账本更新:', JSON.stringify(data, null, 2));
        ledgerSamples.push(data);
      }
    );
    console.log('✅ 账本更新订阅成功');

    // 订阅用户成交
    const fillsSub = await client.userFills(
      { user: testAddress },
      (data) => {
        console.log('💰 收到用户成交:', JSON.stringify(data, null, 2));
        fillSamples.push(data);
      }
    );
    console.log('✅ 用户成交订阅成功\n');

    console.log('🔍 等待数据接收 (30秒)...');
    console.log('   注意: 如果该地址近期没有活动，可能不会收到数据');
    console.log('   这是正常的，我们主要是测试连接和数据格式\n');

    // 等待30秒收集数据
    await new Promise(resolve => setTimeout(resolve, 30000));

    // 输出收集到的数据统计
    console.log('📈 数据收集统计:');
    console.log(`   用户事件: ${eventSamples.length} 条`);
    console.log(`   账本更新: ${ledgerSamples.length} 条`);
    console.log(`   用户成交: ${fillSamples.length} 条`);

    if (eventSamples.length > 0) {
      console.log('\n📋 用户事件样本结构:');
      console.log(JSON.stringify(eventSamples[0], null, 2));
    }

    if (ledgerSamples.length > 0) {
      console.log('\n📋 账本更新样本结构:');
      console.log(JSON.stringify(ledgerSamples[0], null, 2));
    }

    if (fillSamples.length > 0) {
      console.log('\n📋 用户成交样本结构:');
      console.log(JSON.stringify(fillSamples[0], null, 2));
    }

    // 清理订阅
    await userEventsSub.unsubscribe();
    await ledgerSub.unsubscribe();
    await fillsSub.unsubscribe();
    console.log('\n✅ 订阅已清理');

    await transport.close();
    console.log('✅ WebSocket连接已关闭');

    console.log('\n🎉 Hyperliquid WebSocket测试完成！');

    // 如果没有收到数据，给出指导
    if (eventSamples.length === 0 && ledgerSamples.length === 0 && fillSamples.length === 0) {
      console.log('\n💡 未收到数据的可能原因:');
      console.log('   1. 该地址近期没有交易活动');
      console.log('   2. HYPE代币可能需要特定的订阅参数');
      console.log('   3. 可能需要订阅不同的事件类型');
      console.log('\n📝 建议下一步:');
      console.log('   1. 测试更活跃的地址');
      console.log('   2. 查看Hyperliquid API文档获取HYPE资产ID');
      console.log('   3. 尝试订阅所有资产的事件');
    }

  } catch (error) {
    console.error('❌ WebSocket测试失败:', error);
    await transport.close();
    process.exit(1);
  }
}

// 运行测试
testHyperliquidWebSocket().catch((error) => {
  console.error('❌ Hyperliquid连接测试失败:', error);
  process.exit(1);
});
