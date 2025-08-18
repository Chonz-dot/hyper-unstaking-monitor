// Node.js兼容性polyfill - 必须在所有其他导入之前
// Promise.withResolvers 需要 Node.js v22+，为v20提供polyfill支持
import './polyfills';

import RpcContractMonitor from './services/rpcContractMonitor';
import HybridRpcContractMonitor from './services/hybridRpcContractMonitor';
import PureRpcContractMonitor from './services/pureRpcContractMonitor';
import RpcSpotMonitor from './services/rpcSpotMonitor';
import TraderStatsService from './services/TraderStatsService';
import AlertEngine from './engine/alert-engine';
import CacheManager from './cache';
import WebhookNotifier from './webhook';
import logger from './logger';
import config from './config';
import { ContractEvent, ContractTrader, MonitorEvent } from './types';

// 全局系统启动时间
export const SYSTEM_START_TIME = Date.now();

class TraderMonitor {
  private contractMonitor?: RpcContractMonitor | HybridRpcContractMonitor | PureRpcContractMonitor;
  private spotMonitor?: RpcSpotMonitor;
  private alertEngine: AlertEngine;
  private cache: CacheManager;
  private notifier: WebhookNotifier;
  private traderStats: TraderStatsService;
  private isRunning = false;
  private startTime = 0;

  constructor() {
    // 初始化组件
    this.cache = new CacheManager();
    this.notifier = new WebhookNotifier();
    this.alertEngine = new AlertEngine(this.cache, this.notifier);
    this.traderStats = new TraderStatsService();

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
        selectedMonitor: monitorType === 'rpc' ? 'RpcContractMonitor' :
                        monitorType === 'hybrid' ? 'HybridRpcContractMonitor' :
                        'PureRpcContractMonitor'
      });
      
      switch (monitorType) {
        case 'pure-rpc':
        default:
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
      }

      // 监听合约事件
      this.contractMonitor.on('contractEvent', this.handleContractEvent.bind(this));
      logger.info('🎯 RPC合约监控器初始化完成', { type: monitorType });
    } else {
      logger.warn('❌ 合约监控未启用，请检查 CONTRACT_MONITORING_ENABLED 环境变量');
      logger.warn('当前环境变量值:', {
        CONTRACT_MONITORING_ENABLED: process.env.CONTRACT_MONITORING_ENABLED,
        configValue: config.contractMonitoring.enabled
      });
    }

    // 初始化现货转账监听器（RPC版本）
    logger.info('🔧 初始化RPC现货转账监听器...', {
      addressCount: config.monitoring.addresses.length,
      singleThreshold: config.monitoring.singleThreshold,
      cumulativeThreshold: config.monitoring.cumulative24hThreshold,
      strategy: 'RPC轮询（更稳定）'
    });

    this.spotMonitor = new RpcSpotMonitor(config.monitoring.addresses);
    this.spotMonitor.on('spotEvent', this.handleSpotTransferEvent.bind(this));

    logger.info('HYPE解锁监控系统初始化完成', {
      transferMonitoring: true,
      contractMonitoring: config.contractMonitoring.enabled,
      contractTraders: config.contractMonitoring.enabled ? config.contractMonitoring.traders.length : 0,
      spotAddresses: config.monitoring.addresses.length
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
      
      // 连接TraderStats Redis
      await this.traderStats.connect();

      // 更新监控状态
      await this.cache.updateMonitoringStatus({
        startTime: this.startTime,
        lastUpdate: Date.now(),
      });

      // 启动合约监控（如果启用）
      logger.info('检查合约监控器状态...', {
        contractMonitorExists: !!this.contractMonitor,
        configEnabled: config.contractMonitoring.enabled,
        envVar: process.env.CONTRACT_MONITORING_ENABLED
      });

      if (this.contractMonitor) {
        try {
          logger.info('开始启动RPC合约监控器...');
          
          // 添加超时机制，防止启动卡住
          await Promise.race([
            this.contractMonitor.start(),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('合约监控器启动超时')), 60000) // 60秒超时
            )
          ]);
          
          logger.info('✅ RPC合约监控启动完成', this.contractMonitor.getStats());
        } catch (error) {
          logger.error('RPC合约监控启动失败:', error);
          // 不抛出错误，继续运行其他功能
        }
      } else {
        logger.warn('合约监控器未初始化，跳过启动');
      }

      // 启动现货转账监听器（RPC版本）
      if (this.spotMonitor) {
        try {
          logger.info('开始启动RPC现货转账监听器...');
          
          await Promise.race([
            this.spotMonitor.start(),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('RPC现货监听器启动超时')), 60000) // 1分钟超时
            )
          ]);
          
          logger.info('✅ RPC现货转账监听器启动完成', {
            addressCount: config.monitoring.addresses.length,
            strategy: 'RPC轮询',
            stats: this.spotMonitor.getStats()
          });
        } catch (error) {
          logger.error('RPC现货转账监听器启动失败:', error);
          // 不抛出错误，继续运行其他功能
        }
      } else {
        logger.warn('RPC现货监听器未初始化，跳过启动');
      }

      this.isRunning = true;

      logger.info('交易员监控系统启动成功', {
        systemStartTime: new Date(SYSTEM_START_TIME).toISOString(),
        contractMonitoring: {
          enabled: config.contractMonitoring.enabled,
          type: 'RPC-轮询',
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

  private async handleSpotTransferEvent(event: MonitorEvent): Promise<void> {
    try {
      logger.info('收到现货转账事件', {
        eventType: event.eventType,
        address: event.address,
        amount: event.amount,
        hash: event.hash,
        asset: event.asset
      });

      // 通过警报引擎处理现货转账事件
      await this.alertEngine.processEvent(event);

    } catch (error) {
      logger.error('处理现货转账事件失败:', error, { event });
    }
  }

  private async handleContractEvent(event: any, trader: ContractTrader): Promise<void> {
    try {
      // 🔍 调试日志：追踪事件接收
      logger.info('🔍 [调试] 收到合约事件', {
        trader: trader.label,
        alertType: event.alertType || event.eventType,
        asset: event.asset,
        size: event.size,
        side: event.side,
        useAdvancedAnalysis: event.useAdvancedAnalysis || false,
        alertLevel: event.alertLevel || 'basic',
        source: event.metadata?.source || 'unknown',
        eventPath: '主处理器接收事件'
      });

      // 📊 更新交易统计
      await this.updateTraderStats(event, trader);

      // 🆕 获取统计数据并添加到事件中
      const stats = await this.traderStats.getTraderStats(trader.address);
      const formattedStats = this.traderStats.formatStatsForDisplay(stats);
      
      // 将统计数据添加到事件中
      event.traderStats = formattedStats;

      // 统一发送交易分析告警（已经是格式化的告警对象）
      await this.notifier.sendContractAlert(event);
      
      // 🔍 调试日志：确认发送
      logger.info('✅ [调试] 合约事件已发送到webhook', {
        trader: trader.label,
        alertType: event.alertType || event.eventType,
        useAdvancedAnalysis: event.useAdvancedAnalysis || false,
        totalTrades: formattedStats.totalTrades,
        winRate: formattedStats.winRate
      });

    } catch (error) {
      logger.error('处理合约事件失败:', error, { event, trader });
    }
  }

  /**
   * 更新交易员统计数据
   */
  private async updateTraderStats(event: any, trader: ContractTrader): Promise<void> {
    try {
      const notionalValue = parseFloat(event.notionalValue || event.size || '0') * parseFloat(event.price || '0');
      const alertType = event.alertType || event.eventType;
      
      // 确定交易类型
      let tradeType: 'open' | 'close' | 'increase' | 'decrease' = 'open';
      if (alertType.includes('close')) {
        tradeType = 'close';
      } else if (alertType.includes('increase')) {
        tradeType = 'increase';
      } else if (alertType.includes('decrease')) {
        tradeType = 'decrease';
      }

      // 🔧 添加交易类型识别调试
      logger.info('🔍 [调试] 交易类型识别', {
        trader: trader.label,
        asset: event.asset,
        originalAlertType: alertType,
        determinedTradeType: tradeType,
        includesClose: alertType.includes('close'),
        includesIncrease: alertType.includes('increase'),
        includesDecrease: alertType.includes('decrease')
      });

      // 获取盈亏信息（如果是平仓）
      let realizedPnL: number | undefined;
      if (tradeType === 'close' && event.realizedPnL !== undefined) {
        realizedPnL = parseFloat(event.realizedPnL.toString());
        logger.info('📊 [调试] 发现平仓盈亏数据', {
          trader: trader.label,
          asset: event.asset,
          realizedPnL: realizedPnL,
          eventType: event.alertType || event.eventType
        });
      } else if (tradeType === 'close') {
        logger.warn('⚠️ [调试] 平仓事件缺少盈亏数据', {
          trader: trader.label,
          asset: event.asset,
          hasRealizedPnL: event.realizedPnL !== undefined,
          eventRealizedPnL: event.realizedPnL,
          eventType: event.alertType || event.eventType
        });
      }

      // 记录交易
      await this.traderStats.recordTrade(
        trader.address,
        event.asset,
        notionalValue,
        tradeType,
        realizedPnL
      );

      // 如果是开仓，记录持仓信息
      if (tradeType === 'open') {
        await this.traderStats.recordPosition(trader.address, event.asset, {
          asset: event.asset,
          size: parseFloat(event.size || '0'),
          entryPrice: parseFloat(event.price || '0'),
          totalNotional: notionalValue,
          openTime: Date.now(),
          unrealizedPnL: 0
        });
      }

    } catch (error) {
      logger.error('更新交易员统计失败:', error);
    }
  }

  private async cleanup(): Promise<void> {
    try {
      // 停止合约监控
      if (this.contractMonitor) {
        await this.contractMonitor.stop();
      }

      // 停止现货转账监听器
      if (this.spotMonitor) {
        await this.spotMonitor.stop();
      }

      // 断开Redis连接
      await this.cache.disconnect();
      
      // 断开TraderStats Redis连接
      await this.traderStats.disconnect();

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
    contractStats: any;
    stats: any;
  }> {
    const now = Date.now();
    const uptime = this.isRunning ? now - this.startTime : 0;

    return {
      isRunning: this.isRunning,
      startTime: this.startTime,
      uptime,
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
const monitor = new TraderMonitor();

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
        RPC监控: status.contractStats?.isRunning ? '正常' : '断开',
        监控交易员: status.contractStats?.traders || 0,
        成功率: status.contractStats?.successRate || '0%',
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
export { TraderMonitor };
