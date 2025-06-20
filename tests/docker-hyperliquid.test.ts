import * as hl from '@nktkas/hyperliquid';
import logger from '../src/logger';

async function testHyperliquidInDocker() {
  console.log('🐳 在Docker环境中测试Hyperliquid连接...\n');
  console.log(`Node.js版本: ${process.version}`);
  
  try {
    // 1. 测试HTTP API
    console.log('1️⃣ 测试HTTP API连接');
    const httpTransport = new hl.HttpTransport();
    const infoClient = new hl.InfoClient({ transport: httpTransport });
    
    const meta = await infoClient.meta();
    console.log(`✅ HTTP API成功: ${meta.universe.length} 个资产`);
    
    // 查找HYPE
    const hypeAsset = meta.universe.find(asset => asset.name === 'HYPE');
    if (hypeAsset) {
      console.log(`✅ 找到HYPE资产: ${JSON.stringify(hypeAsset)}`);
    }

    // 2. 测试WebSocket连接
    console.log('\n2️⃣ 测试WebSocket连接');
    const transport = new hl.WebSocketTransport({
      url: 'wss://api.hyperliquid.xyz/ws',
      timeout: 10000,
    });
    
    const client = new hl.SubscriptionClient({ transport });
    
    await transport.ready();
    console.log('✅ WebSocket连接成功');
    
    // 简单测试订阅
    const sub = await client.allMids((data) => {
      console.log('📊 收到市场数据:', Object.keys(data).length + ' 个资产');
    });
    
    console.log('✅ WebSocket订阅成功');
    
    // 等待5秒
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    await sub.unsubscribe();
    await transport.close();
    
    console.log('\n🎉 Docker环境中Hyperliquid测试完全成功！');
    console.log('Node.js 24+ 解决了所有兼容性问题');

  } catch (error) {
    console.error('❌ Docker测试失败:', error);
    process.exit(1);
  }
}

// 运行测试
testHyperliquidInDocker().catch((error) => {
  console.error('❌ Docker测试完全失败:', error);
  process.exit(1);
});
