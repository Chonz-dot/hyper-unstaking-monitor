import { MonitorEvent, AlertRule, WebhookAlert, WatchedAddress } from '../types';
import CacheManager from '../cache';
import WebhookNotifier from '../webhook';
import logger from '../logger';
import config from '../config';

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
        threshold: config.monitoring.dailyThreshold,
        timeWindow: 24, // 24小时
        enabled: true,
      },
    ];

    logger.info('预警引擎初始化完成', {
      rulesCount: this.rules.length,
      addressesCount: this.addressMap.size,
      singleThreshold: config.monitoring.singleThreshold,
      dailyThreshold: config.monitoring.dailyThreshold,
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

      logger.debug('处理监控事件', {
        address: addressInfo.label,
        eventType: event.eventType,
        amount: event.amount,
        txHash: event.hash.substring(0, 10) + '...',
      });

      // 检查交易是否已处理（去重）
      if (await this.cache.isTransactionProcessed(event.hash)) {
        logger.debug(`交易已处理，跳过: ${event.hash.substring(0, 10)}...`);
        return;
      }

      // 标记交易为已处理
      await this.cache.markTransactionProcessed(event.hash);

      // 更新缓存
      const direction = event.eventType.includes('in') ? 'in' : 'out';
      await this.cache.updateDailyCache(event.address, event.amount, event.hash, direction);

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
        addressLabel: addressInfo.label,
        amount: event.amount,
        txHash: event.hash,
        blockTime: event.blockTime,
        unlockAmount: addressInfo.unlockAmount,
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

    // 获取今日累计数据
    const dailyCache = await this.cache.getDailyCache(event.address);
    if (!dailyCache) return;

    const threshold = addressInfo.customThresholds?.dailyTotal || rule.threshold;
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
        addressLabel: addressInfo.label,
        amount: event.amount,
        txHash: event.hash,
        blockTime: event.blockTime,
        cumulativeToday: cumulativeAmount.toString(),
        unlockAmount: addressInfo.unlockAmount,
      };

      logger.info(`触发累计转账预警: ${alertType}`, {
        address: addressInfo.label,
        cumulativeAmount,
        threshold,
        direction,
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
}

export default AlertEngine;
