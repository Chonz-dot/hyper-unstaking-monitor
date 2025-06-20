import HyperliquidMonitor from './services/hyperliquid-monitor';
import AlertEngine from './engine/alert-engine';
import CacheManager from './cache';
import WebhookNotifier from './webhook';
import logger from './logger';
import config from './config';
import { MonitorEvent } from './types';

// 全局系统启动时间
export const SYSTEM_START_TIME = Date.now();

class HypeUnstakingMonitor {
  private hyperliquidMonitor: HyperliquidMonitor;
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
    this.hyperliquidMonitor = new HyperliquidMonitor(this.handleEvent.bind(this));

    logger.info('HYPE解锁监控系统初始化完成');
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

      // 测试Webhook连接
      const webhookTest = await this.notifier.testConnection();
      if (!webhookTest) {
        logger.warn('Webhook连接测试失败，但继续启动监控');
      }

      // 更新监控状态
      await this.cache.updateMonitoringStatus({
        startTime: this.startTime,
        lastUpdate: Date.now(),
      });

      // 启动Hyperliquid监控
      await this.hyperliquidMonitor.start();

      this.isRunning = true;

      logger.info('HYPE解锁监控系统启动成功', {
        systemStartTime: new Date(SYSTEM_START_TIME).toISOString(),
        addressCount: config.monitoring.addresses.length,
        singleThreshold: config.monitoring.singleThreshold,
        cumulative24hThreshold: config.monitoring.cumulative24hThreshold,
        timeWindow: '24小时滚动窗口（从启动时间开始）'
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

      // 处理事件
      await this.alertEngine.processEvent(event);

    } catch (error) {
      logger.error('处理监控事件失败:', error, { event });
    }
  }

  private async cleanup(): Promise<void> {
    try {
      // 停止Hyperliquid监控
      await this.hyperliquidMonitor.stop();

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
    stats: any;
  }> {
    const now = Date.now();
    const uptime = this.isRunning ? now - this.startTime : 0;

    return {
      isRunning: this.isRunning,
      startTime: this.startTime,
      uptime,
      hyperliquidStatus: this.hyperliquidMonitor.getStatus(),
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
