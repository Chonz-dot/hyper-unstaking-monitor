import config from '../src/config';
import logger from '../src/logger';
import { MonitorEvent } from '../src/types';

// 模拟缓存管理器（不依赖Redis）
class MockCacheManager {
  private cache = new Map<string, any>();
  private processedTxs = new Set<string>();

  async connect(): Promise<void> {
    logger.info('MockCache: 连接成功');
  }

  async disconnect(): Promise<void> {
    logger.info('MockCache: 断开连接');
  }

  async getDailyCache(address: string): Promise<any> {
    return this.cache.get(`daily:${address}`) || {
      totalInbound: '0',
      totalOutbound: '0',
      transactions: [],
      lastReset: Date.now(),
    };
  }

  async updateDailyCache(address: string, amount: string, txHash: string, direction: 'in' | 'out'): Promise<void> {
    const key = `daily:${address}`;
    const cache = await this.getDailyCache(address);
    
    cache.transactions.push({ amount, timestamp: Date.now(), txHash, direction });
    
    const amountNum = parseFloat(amount);
    if (direction === 'in') {
      cache.totalInbound = (parseFloat(cache.totalInbound) + amountNum).toString();
    } else {
      cache.totalOutbound = (parseFloat(cache.totalOutbound) + amountNum).toString();
    }
    
    this.cache.set(key, cache);
    logger.debug(`MockCache: 更新${direction === 'in' ? '转入' : '转出'}缓存 ${address}: ${amount}`);
  }

  async isTransactionProcessed(txHash: string): Promise<boolean> {
    return this.processedTxs.has(txHash);
  }

  async markTransactionProcessed(txHash: string): Promise<void> {
    this.processedTxs.add(txHash);
  }

  async updateMonitoringStatus(status: any): Promise<void> {
    this.cache.set('status', status);
  }
}

// 模拟Webhook通知器
class MockWebhookNotifier {
  async sendAlert(alert: any): Promise<void> {
    console.log(`🚨 模拟警报发送: ${alert.alertType}`);
    console.log(`   地址: ${alert.addressLabel}`);
    console.log(`   金额: ${alert.amount} HYPE`);
    console.log(`   交易: ${alert.txHash.substring(0, 10)}...`);
    if (alert.cumulativeToday) {
      console.log(`   今日累计: ${alert.cumulativeToday} HYPE`);
    }
    console.log('');
  }
}

async function testAlertEngine() {
  console.log('⚙️ 开始测试预警引擎功能...\n');

  // 动态导入预警引擎
  const { AlertEngine } = await import('../src/engine/alert-engine');
  
  const mockCache = new MockCacheManager();
  const mockNotifier = new MockWebhookNotifier();
  
  await mockCache.connect();
  const alertEngine = new AlertEngine(mockCache, mockNotifier);

  // 测试事件
  const testEvents: MonitorEvent[] = [
    {
      timestamp: Date.now(),
      address: '0x5d83bb3313240cab65e2e9200d3aaf3520474fb6', // 主要解锁地址
      eventType: 'transfer_in',
      amount: '15000', // 超过单笔阈值10000
      hash: '0xtest1_large_transfer',
      blockTime: Date.now() - 1000,
      asset: 'HYPE',
    },
    {
      timestamp: Date.now(),
      address: '0xda3cdff67ce27fa68ba5600a7c95efd8153d9f15', // 解锁地址2
      eventType: 'transfer_out',
      amount: '8000', // 未超过单笔阈值
      hash: '0xtest2_small_transfer',
      blockTime: Date.now() - 2000,
      asset: 'HYPE',
    },
    {
      timestamp: Date.now(),
      address: '0xda3cdff67ce27fa68ba5600a7c95efd8153d9f15', // 同一地址
      eventType: 'transfer_in',
      amount: '30000', // 超过单笔阈值，累计也会超过
      hash: '0xtest3_large_transfer',
      blockTime: Date.now() - 3000,
      asset: 'HYPE',
    },
    {
      timestamp: Date.now(),
      address: '0xda3cdff67ce27fa68ba5600a7c95efd8153d9f15', // 同一地址
      eventType: 'transfer_in',
      amount: '25000', // 继续累计
      hash: '0xtest4_cumulative',
      blockTime: Date.now() - 4000,
      asset: 'HYPE',
    },
  ];

  console.log('📊 处理测试事件:\n');

  for (let i = 0; i < testEvents.length; i++) {
    const event = testEvents[i];
    console.log(`${i + 1}️⃣ 处理事件: ${event.eventType} - ${event.amount} HYPE`);
    console.log(`   地址: ${config.monitoring.addresses.find(a => a.address === event.address)?.label}`);
    console.log(`   交易: ${event.hash}`);
    
    await alertEngine.processEvent(event);
    
    // 等待一下以便观察日志
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  // 获取统计信息
  console.log('📈 获取系统统计信息:');
  const stats = await alertEngine.getStats();
  console.log(`- 监控地址总数: ${stats.totalAddresses}`);
  console.log(`- 活跃规则数: ${stats.activeRules}`);
  console.log('- 今日统计:');
  Object.entries(stats.dailyStats).forEach(([label, data]) => {
    if (parseFloat(data.inbound) > 0 || parseFloat(data.outbound) > 0) {
      console.log(`  ${label}: 转入${data.inbound} HYPE, 转出${data.outbound} HYPE`);
    }
  });

  await mockCache.disconnect();
  console.log('\n🎉 预警引擎功能测试完成！');
}

// 运行测试
testAlertEngine().catch((error) => {
  console.error('❌ 预警引擎测试失败:', error);
  process.exit(1);
});
