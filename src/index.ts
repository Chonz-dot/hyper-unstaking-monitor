// Node.js兼容性polyfill - 必须在所有其他导入之前
// Promise.withResolvers 需要 Node.js v22+，为v20提供polyfill支持
import './polyfills';

import HyperliquidMonitor from './services/hyperliquid-monitor';
import BatchedHyperliquidMonitor from './services/hyperliquid-monitor';
import { WebSocketContractMonitor } from './services/webSocketContractMonitor';
import PooledWebSocketContractMonitor from './services/pooledWebSocketContractMonitor';
import RobustWebSocketContractMonitor from './services/robustWebSocketContractMonitor';
import RpcContractMonitor from './services/rpcContractMonitor';
import HybridRpcContractMonitor from './services/hybridRpcContractMonitor';
import PureRpcContractMonitor from './services/pureRpcContractMonitor';
import AlertEngine from './engine/alert-engine';
import CacheManager from './cache';
import WebhookNotifier from './webhook';
import logger from './logger';
import config from './config';
import { MonitorEvent, ContractEvent, ContractTrader } from './types';

// 全局系统启动时间
export const SYSTEM_START_TIME = Date.now();

class HypeUnstakingMonitor {
  private hyperliquidMonitor: BatchedHyperliquidMonitor;
  private contractMonitor?: WebSocketContractMonitor | PooledWebSocketContractMonitor | RobustWebSocketContractMonitor | RpcContractMonitor | HybridRpcContractMonitor | PureRpcContractMonitor;
  private alertEngine: AlertEngine;
  private cache: CacheManager;
  private notifier: WebhookNotifier;
  private isRunning = false;
  private startTime = 0;

  constructor() {
    // 初始化组件
    this.cache = new CacheManager();
    this.notifier = new WebhookNotifier();
    this.alertEngine = new AlertEngine(this.cache, this.notifier);
    this.hyperliquidMonitor = new BatchedHyperliquidMonitor(this.handleEvent.bind(this));

    // 如果启用了合约监控，初始化合约监控器
    logger.info('🔧 检查合约监控配置', {
      enabled: config.contractMonitoring.enabled,
      tradersCount: config.contractMonitoring.traders.length,
      monitorType: config.contractMonitoring.monitorType,
      envEnabled: process.env.CONTRACT_MONITORING_ENABLED,
      tradersList: config.contractMonitoring.traders.map(t => ({ label: t.label, isActive: t.isActive }))
    });

    if (config.contractMonitoring.enabled) {
      // 根据配置文件选择监控器类型
      const monitorType = config.contractMonitoring.monitorType || 'pure-rpc';
      
      logger.info(`✅ 合约监控已启用，使用${monitorType}监控器...`, {
        envValue: process.env.CONTRACT_MONITOR_TYPE,
        configValue: config.contractMonitoring.monitorType,
        actualMonitorType: monitorType,
        selectedMonitor: monitorType === 'pooled' ? 'PooledWebSocketContractMonitor' : 
                        monitorType === 'robust' ? 'RobustWebSocketContractMonitor' : 
                        monitorType === 'rpc' ? 'RpcContractMonitor' :
                        monitorType === 'hybrid' ? 'HybridRpcContractMonitor' :
                        monitorType === 'pure-rpc' ? 'PureRpcContractMonitor' :
                        'WebSocketContractMonitor'
      });
      
      switch (monitorType) {
        case 'pure-rpc':
          this.contractMonitor = new PureRpcContractMonitor(
            config.contractMonitoring.traders,
            config.contractMonitoring.minNotionalValue
          );
          break;
        case 'hybrid':
          this.contractMonitor = new HybridRpcContractMonitor(
            config.contractMonitoring.traders,
            config.contractMonitoring.minNotionalValue
          );
          break;
        case 'rpc':
          this.contractMonitor = new RpcContractMonitor(
            config.contractMonitoring.traders,
            config.contractMonitoring.minNotionalValue
          );
          break;
        case 'pooled':
          this.contractMonitor = new PooledWebSocketContractMonitor(
            config.contractMonitoring.traders,
            config.contractMonitoring.minNotionalValue
          );
          break;
        case 'robust':
          this.contractMonitor = new RobustWebSocketContractMonitor(
            config.contractMonitoring.traders,
            config.contractMonitoring.minNotionalValue
          );
          break;
        case 'single':
        default:
          this.contractMonitor = new WebSocketContractMonitor(
            config.contractMonitoring.traders,
            config.contractMonitoring.minNotionalValue
          );
          break;
      }

      // 监听合约事件
      this.contractMonitor.on('contractEvent', this.handleContractEvent.bind(this));
      logger.info('🎯 WebSocket合约监控器初始化完成', { type: monitorType });
    } else {
      logger.warn('❌ 合约监控未启用，请检查 CONTRACT_MONITORING_ENABLED 环境变量');
      logger.warn('当前环境变量值:', {
        CONTRACT_MONITORING_ENABLED: process.env.CONTRACT_MONITORING_ENABLED,
        configValue: config.contractMonitoring.enabled
      });
    }

    logger.info('HYPE解锁监控系统初始化完成', {
      transferMonitoring: true,
      contractMonitoring: config.contractMonitoring.enabled,
      contractTraders: config.contractMonitoring.enabled ? config.contractMonitoring.traders.length : 0
    });
  }

  async start(): Promise<void> {
    try {
      if (this.isRunning) {
        logger.warn('监控系统已在运行中');
        return;
      }

      logger.info('启动HYPE解锁监控系统...');
      this.startTime = Date.now();

      // 连接Redis
      await this.cache.connect();

      // 更新监控状态
      await this.cache.updateMonitoringStatus({
        startTime: this.startTime,
        lastUpdate: Date.now(),
      });

      // 启动Hyperliquid监控
      this.hyperliquidMonitor.start();

      // 启动合约监控（如果启用）
      logger.info('检查合约监控器状态...', {
        contractMonitorExists: !!this.contractMonitor,
        configEnabled: config.contractMonitoring.enabled,
        envVar: process.env.CONTRACT_MONITORING_ENABLED
      });

      if (this.contractMonitor) {
        try {
          logger.info('开始启动WebSocket合约监控器...');
          
          // 添加超时机制，防止启动卡住
          await Promise.race([
            this.contractMonitor.start(),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('合约监控器启动超时')), 60000) // 60秒超时
            )
          ]);
          
          logger.info('✅ WebSocket合约监控启动完成', this.contractMonitor.getStats());
        } catch (error) {
          logger.error('WebSocket合约监控启动失败:', error);
          // 不抛出错误，继续运行其他功能
        }
      } else {
        logger.warn('合约监控器未初始化，跳过启动');
      }

      this.isRunning = true;

      logger.info('HYPE解锁监控系统启动成功', {
        systemStartTime: new Date(SYSTEM_START_TIME).toISOString(),
        addressCount: config.monitoring.addresses.length,
        singleThreshold: config.monitoring.singleThreshold,
        cumulative24hThreshold: config.monitoring.cumulative24hThreshold,
        timeWindow: '24小时滚动窗口（从启动时间开始）',
        monitoringType: 'BatchedWebSocket',
        batchInfo: this.hyperliquidMonitor.getStatus(),
        contractMonitoring: {
          enabled: config.contractMonitoring.enabled,
          type: 'WebSocket-userEvents',
          traders: this.contractMonitor?.getStats()
        }
      });

      // 定期更新状态
      this.startStatusUpdater();

    } catch (error) {
      logger.error('启动监控系统失败:', error);
      await this.cleanup();
      throw error;
    }
  }

  async stop(): Promise<void> {
    try {
      if (!this.isRunning) {
        logger.warn('监控系统未在运行');
        return;
      }

      logger.info('停止HYPE解锁监控系统...');
      this.isRunning = false;

      await this.cleanup();

      logger.info('HYPE解锁监控系统已停止');

    } catch (error) {
      logger.error('停止监控系统失败:', error);
    }
  }

  private async handleEvent(event: MonitorEvent): Promise<void> {
    try {
      // 更新最后更新时间
      await this.cache.updateMonitoringStatus({
        startTime: this.startTime,
        lastUpdate: Date.now(),
      });

      // 处理转账事件
      await this.alertEngine.processEvent(event);

    } catch (error) {
      logger.error('处理监控事件失败:', error, { event });
    }
  }

  private async handleContractEvent(event: ContractEvent, trader: ContractTrader): Promise<void> {
    try {
      logger.info('收到合约事件', {
        trader: trader.label,
        eventType: event.eventType,
        asset: event.asset,
        size: event.size,
        side: event.side
      });

      // 创建webhook警报
      if (this.contractMonitor) {
        const alert = this.contractMonitor.createWebhookAlert(event, trader);
        await this.notifier.sendContractAlert(alert);
      }

    } catch (error) {
      logger.error('处理合约事件失败:', error, { event, trader });
    }
  }

  private async cleanup(): Promise<void> {
    try {
      // 停止Hyperliquid监控
      await this.hyperliquidMonitor.stop();

      // 停止合约监控
      if (this.contractMonitor) {
        await this.contractMonitor.stop();
      }

      // 断开Redis连接
      await this.cache.disconnect();

      logger.info('清理完成');

    } catch (error) {
      logger.error('清理过程中出错:', error);
    }
  }

  private startStatusUpdater(): void {
    // 每30秒更新一次状态
    const interval = setInterval(async () => {
      if (!this.isRunning) {
        clearInterval(interval);
        return;
      }

      try {
        await this.cache.updateMonitoringStatus({
          startTime: this.startTime,
          lastUpdate: Date.now(),
        });
      } catch (error) {
        logger.error('更新状态失败:', error);
      }
    }, 30000);
  }

  // 获取系统状态
  async getSystemStatus(): Promise<{
    isRunning: boolean;
    startTime: number;
    uptime: number;
    hyperliquidStatus: any;
    contractStats: any;
    stats: any;
  }> {
    const now = Date.now();
    const uptime = this.isRunning ? now - this.startTime : 0;

    return {
      isRunning: this.isRunning,
      startTime: this.startTime,
      uptime,
      hyperliquidStatus: this.hyperliquidMonitor.getStatus(),
      contractStats: this.contractMonitor?.getStats() || null,
      stats: await this.alertEngine.getStats(),
    };
  }

  // 优雅关闭
  async gracefulShutdown(): Promise<void> {
    logger.info('接收到关闭信号，开始优雅关闭...');

    await this.stop();

    logger.info('优雅关闭完成');
    process.exit(0);
  }
}

// 创建监控实例
const monitor = new HypeUnstakingMonitor();

// 处理进程信号
process.on('SIGINT', () => monitor.gracefulShutdown());
process.on('SIGTERM', () => monitor.gracefulShutdown());

// 处理未捕获的异常
process.on('uncaughtException', (error) => {
  logger.error('未捕获的异常:', error);
  monitor.gracefulShutdown();
});

process.on('unhandledRejection', (reason) => {
  logger.error('未处理的Promise拒绝:', reason);
  monitor.gracefulShutdown();
});

// 启动监控
async function main() {
  try {
    await monitor.start();

    // 定期输出状态报告
    setInterval(async () => {
      const status = await monitor.getSystemStatus();
      logger.info('系统状态报告', {
        运行时长: Math.floor(status.uptime / 1000) + '秒',
        Hyperliquid连接: status.hyperliquidStatus.isRunning ? '正常' : '断开',
        订阅数量: status.hyperliquidStatus.subscriptionsCount,
        监控地址: status.stats.totalAddresses,
        活跃规则: status.stats.activeRules,
      });
    }, 300000); // 每5分钟输出一次状态

  } catch (error) {
    logger.error('启动失败:', error);
    process.exit(1);
  }
}

// 如果直接运行此文件，启动监控
if (require.main === module) {
  main().catch((error) => {
    logger.error('主程序异常:', error);
    process.exit(1);
  });
}

export default monitor;
export { HypeUnstakingMonitor };
