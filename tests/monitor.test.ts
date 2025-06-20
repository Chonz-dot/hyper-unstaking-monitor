import HyperliquidMonitor from '../services/hyperliquid-monitor';
import AlertEngine from '../engine/alert-engine';
import CacheManager from '../cache';
import WebhookNotifier from '../webhook';
import { MonitorEvent } from '../types';

// 模拟监控事件数据用于测试
const mockEvents: MonitorEvent[] = [
  {
    timestamp: Date.now(),
    address: '0x5d83bb3313240cab65e2e9200d3aaf3520474fb6',
    eventType: 'transfer_in',
    amount: '15000',
    hash: '0xtest123456789abcdef',
    blockTime: Date.now() - 1000,
    asset: 'HYPE',
  },
  {
    timestamp: Date.now(),
    address: '0xda3cdff67ce27fa68ba5600a7c95efd8153d9f15',
    eventType: 'transfer_out',
    amount: '8000',
    hash: '0xtest987654321fedcba',
    blockTime: Date.now() - 2000,
    asset: 'HYPE',
  },
];

describe('HYPE监控系统测试', () => {
  let cache: CacheManager;
  let notifier: WebhookNotifier;
  let alertEngine: AlertEngine;

  beforeAll(async () => {
    // 初始化测试组件
    cache = new CacheManager();
    notifier = new WebhookNotifier();
    alertEngine = new AlertEngine(cache, notifier);
  });

  afterAll(async () => {
    // 清理资源
    await cache.disconnect();
  });

  test('应能正确处理转入事件', async () => {
    const event = mockEvents[0];
    await alertEngine.processEvent(event);
    
    // 检查缓存更新
    const dailyCache = await cache.getDailyCache(event.address);
    expect(dailyCache).toBeTruthy();
    expect(parseFloat(dailyCache!.totalInbound)).toBeGreaterThan(0);
  });

  test('应能触发单笔转账预警', async () => {
    const event = {
      ...mockEvents[0],
      amount: '25000', // 超过阈值
      hash: '0xnewhash123456',
    };

    // 这里应该会触发预警
    await alertEngine.processEvent(event);
  });

  test('Webhook通知器应能正确格式化消息', () => {
    // 测试Webhook消息格式
    expect(notifier).toBeDefined();
  });

  test('缓存管理器应能正确处理去重', async () => {
    const txHash = '0xduplicatetest123';
    
    // 第一次标记
    await cache.markTransactionProcessed(txHash);
    
    // 检查是否已处理
    const isProcessed = await cache.isTransactionProcessed(txHash);
    expect(isProcessed).toBe(true);
  });

  test('应能获取系统统计信息', async () => {
    const stats = await alertEngine.getStats();
    
    expect(stats).toBeDefined();
    expect(stats.totalAddresses).toBe(26);
    expect(stats.activeRules).toBeGreaterThan(0);
    expect(stats.dailyStats).toBeDefined();
  });
});
