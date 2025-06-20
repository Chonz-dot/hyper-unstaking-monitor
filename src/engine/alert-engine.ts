import { MonitorEvent, AlertRule, WebhookAlert, WatchedAddress } from '../types';
import CacheManager from '../cache';
import WebhookNotifier from '../webhook';
import logger from '../logger';
import config from '../config';
import { SYSTEM_START_TIME } from '../index';

export class AlertEngine {
  private rules: AlertRule[];
  private cache: CacheManager;
  private notifier: WebhookNotifier;
  private addressMap: Map<string, WatchedAddress>;

  constructor(cache: CacheManager, notifier: WebhookNotifier) {
    this.cache = cache;
    this.notifier = notifier;
    this.addressMap = new Map();
    
    // 初始化地址映射
    config.monitoring.addresses.forEach(addr => {
      this.addressMap.set(addr.address.toLowerCase(), addr);
    });

    // 初始化预警规则
    this.rules = [
      {
        type: 'single_transfer',
        threshold: config.monitoring.singleThreshold,
        enabled: true,
      },
      {
        type: 'cumulative_transfer',
        threshold: config.monitoring.cumulative24hThreshold,
        timeWindow: 24, // 24小时滚动窗口
        enabled: true,
      },
    ];

    logger.info('预警引擎初始化完成', {
      rulesCount: this.rules.length,
      addressesCount: this.addressMap.size,
      singleThreshold: config.monitoring.singleThreshold,
      cumulative24hThreshold: config.monitoring.cumulative24hThreshold,
      systemStartTime: new Date(SYSTEM_START_TIME).toISOString(),
    });
  }

  async processEvent(event: MonitorEvent): Promise<void> {
    try {
      // 获取地址信息
      const addressInfo = this.addressMap.get(event.address.toLowerCase());
      if (!addressInfo) {
        logger.warn(`未知地址的事件: ${event.address}`);
        return;
      }

      // 过滤系统启动前的历史事件
      if (event.blockTime < SYSTEM_START_TIME) {
        logger.info(`🔄 跳过系统启动前的历史事件: ${addressInfo.label}`, {
          fullTxHash: event.hash,
          shortTxHash: event.hash.substring(0, 10) + '...',
          amount: event.amount,
          eventType: event.eventType,
          eventTime: new Date(event.blockTime).toISOString(),
          systemStartTime: new Date(SYSTEM_START_TIME).toISOString(),
          timeDiff: Math.round((SYSTEM_START_TIME - event.blockTime) / 1000) + 's ago'
        });
        return;
      }

      logger.info('🎯 处理实时监控事件', {
        address: addressInfo.label,
        fullAddress: event.address,
        eventType: event.eventType,
        amount: event.amount,
        fullTxHash: event.hash,
        shortTxHash: event.hash.substring(0, 10) + '...',
        blockTime: new Date(event.blockTime).toISOString(),
        systemStartTime: new Date(SYSTEM_START_TIME).toISOString()
      });

      // 检查交易是否已处理（去重）
      if (await this.cache.isTransactionProcessed(event.hash)) {
        logger.debug(`交易已处理，跳过: ${event.hash.substring(0, 10)}...`);
        return;
      }

      // 标记交易为已处理
      await this.cache.markTransactionProcessed(event.hash);

      // 更新缓存（使用事件的实际时间戳）
      const direction = event.eventType.includes('in') ? 'in' : 'out';
      await this.cache.updateDailyCache(event.address, event.amount, event.hash, direction, event.blockTime);

      // 检查预警规则
      await Promise.all([
        this.checkSingleTransferAlert(event, addressInfo),
        this.checkCumulativeTransferAlert(event, addressInfo),
      ]);

    } catch (error) {
      logger.error('处理事件失败:', error, { event });
    }
  }

  private async checkSingleTransferAlert(
    event: MonitorEvent,
    addressInfo: WatchedAddress
  ): Promise<void> {
    const rule = this.rules.find(r => r.type === 'single_transfer' && r.enabled);
    if (!rule) return;

    const amount = parseFloat(event.amount);
    const threshold = addressInfo.customThresholds?.singleTransfer || rule.threshold;

    if (amount >= threshold) {
      const alertType = event.eventType.includes('in') 
        ? 'single_transfer_in' as const
        : 'single_transfer_out' as const;

      const alert: WebhookAlert = {
        timestamp: event.timestamp,
        alertType,
        address: event.address,
        addressLabel: addressInfo.label || `地址 ${event.address.substring(0, 10)}...`,
        amount: event.amount,
        txHash: event.hash,
        blockTime: event.blockTime,
        unlockAmount: addressInfo.unlockAmount || 0,
      };

      logger.info(`触发单笔转账预警: ${alertType}`, {
        address: addressInfo.label,
        amount: event.amount,
        threshold,
      });

      await this.notifier.sendAlert(alert);
    }
  }

  private async checkCumulativeTransferAlert(
    event: MonitorEvent,
    addressInfo: WatchedAddress
  ): Promise<void> {
    const rule = this.rules.find(r => r.type === 'cumulative_transfer' && r.enabled);
    if (!rule) return;

    // 获取48小时累计数据
    const dailyCache = await this.cache.getDailyCache(event.address);
    if (!dailyCache) return;

    const threshold = addressInfo.customThresholds?.cumulative24h || rule.threshold;
    const direction = event.eventType.includes('in') ? 'in' : 'out';
    const cumulativeAmount = parseFloat(
      direction === 'in' ? dailyCache.totalInbound : dailyCache.totalOutbound
    );

    if (cumulativeAmount >= threshold) {
      const alertType = direction === 'in' 
        ? 'cumulative_transfer_in' as const
        : 'cumulative_transfer_out' as const;

      const alert: WebhookAlert = {
        timestamp: event.timestamp,
        alertType,
        address: event.address,
        addressLabel: addressInfo.label || `地址 ${event.address.substring(0, 10)}...`,
        amount: event.amount,
        txHash: event.hash,
        blockTime: event.blockTime,
        cumulativeToday: cumulativeAmount.toString(),
        unlockAmount: addressInfo.unlockAmount || 0,
      };

      logger.info(`触发累计转账预警: ${alertType}`, {
        address: addressInfo.label,
        cumulativeAmount,
        threshold,
        direction,
        timeWindow: '24h'
      });

      await this.notifier.sendAlert(alert);
    }
  }

  // 获取统计信息
  async getStats(): Promise<{
    totalAddresses: number;
    activeRules: number;
    dailyStats: { [address: string]: { inbound: string; outbound: string } };
  }> {
    const dailyStats: { [address: string]: { inbound: string; outbound: string } } = {};

    for (const [address, addressInfo] of this.addressMap) {
      const cache = await this.cache.getDailyCache(address);
      dailyStats[addressInfo.label] = {
        inbound: cache?.totalInbound || '0',
        outbound: cache?.totalOutbound || '0',
      };
    }

    return {
      totalAddresses: this.addressMap.size,
      activeRules: this.rules.filter(r => r.enabled).length,
      dailyStats,
    };
  }

  // 获取24小时窗口开始时间戳（基于系统启动时间）
  private get24HourWindowStart(): number {
    const now = Date.now();
    const hoursFromStart = Math.floor((now - SYSTEM_START_TIME) / (24 * 60 * 60 * 1000));
    return SYSTEM_START_TIME + (hoursFromStart * 24 * 60 * 60 * 1000);
  }
}

export default AlertEngine;
