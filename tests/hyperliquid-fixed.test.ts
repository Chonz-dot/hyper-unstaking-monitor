// WebSocket polyfill for Node.js environment
import { WebSocket } from 'ws';

// 添加WebSocket到全局对象
if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = WebSocket as any;
}

import * as hl from '@nktkas/hyperliquid';
import logger from '../src/logger';
import config from '../src/config';

async function testHyperliquidWebSocket() {
  console.log('🌐 开始测试Hyperliquid WebSocket连接...\n');
  console.log('⚠️  注意: @nktkas/hyperliquid 需要 Node.js >= 24，当前版本可能有兼容性问题');
  console.log('   如果遇到问题，我们将实现替代方案\n');

  try {
    // 初始化WebSocket传输
    const transport = new hl.WebSocketTransport({
      url: config.hyperliquid.wsUrl,
      timeout: 10000,
      keepAlive: {
        interval: 30000,
        timeout: 10000,
      },
      reconnect: {
        maxRetries: 2,
        connectionTimeout: 10000,
        connectionDelay: 1000,
      },
    });

    const client = new hl.SubscriptionClient({ transport });

    console.log('1️⃣ 建立WebSocket连接');
    await transport.ready();
    console.log('✅ WebSocket连接成功\n');

    // 先测试简单的订阅
    console.log('2️⃣ 测试基础市场数据订阅');
    
    const allMidsSub = await client.allMids((data) => {
      console.log('📊 收到所有中间价数据样本:');
      console.log(JSON.stringify(data, null, 2));
    });
    
    console.log('✅ 市场数据订阅成功，等待数据...\n');

    // 等待10秒收集数据
    await new Promise(resolve => setTimeout(resolve, 10000));

    await allMidsSub.unsubscribe();
    await transport.close();
    
    console.log('✅ 测试完成，连接已关闭');
    console.log('\n🎉 Hyperliquid WebSocket基础连接测试成功！');

  } catch (error) {
    console.error('❌ WebSocket测试失败:', error);
    console.log('\n💡 替代方案建议:');
    console.log('   1. 升级Node.js到24+版本');
    console.log('   2. 使用HTTP API进行监控');
    console.log('   3. 实现自定义WebSocket客户端');
    
    // 测试HTTP API作为备选
    console.log('\n🔄 尝试HTTP API替代方案...');
    await testHttpAlternative();
  }
}

async function testHttpAlternative() {
  try {
    const httpTransport = new hl.HttpTransport();
    const infoClient = new hl.InfoClient({ transport: httpTransport });
    
    console.log('📡 测试HTTP API连接...');
    
    // 获取市场元数据
    const meta = await infoClient.meta();
    console.log('✅ HTTP API连接成功');
    console.log(`   可用资产数量: ${meta.universe.length}`);
    
    // 查找HYPE资产
    const hypeAsset = meta.universe.find(asset => asset.name === 'HYPE');
    if (hypeAsset) {
      console.log(`✅ 找到HYPE资产: 索引 ${hypeAsset.index}`);
      console.log(`   HYPE资产信息:`, JSON.stringify(hypeAsset, null, 2));
    } else {
      console.log('⚠️  未找到HYPE资产，列出前10个资产:');
      meta.universe.slice(0, 10).forEach((asset, i) => {
        console.log(`   ${i + 1}. ${asset.name} (索引: ${asset.index})`);
      });
    }

    console.log('\n💡 HTTP API方案可行，我们可以实现轮询监控');
    
  } catch (httpError) {
    console.error('❌ HTTP API也失败:', httpError);
  }
}

// 运行测试
testHyperliquidWebSocket().catch((error) => {
  console.error('❌ 连接测试完全失败:', error);
  process.exit(1);
});
