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
        id: 'single_transfer_rule',
        type: 'single_transfer',
        threshold: config.monitoring.singleThreshold,
        enabled: true,
      },
      {
        id: 'cumulative_transfer_rule',
        type: 'cumulative_transfer',
        threshold: config.monitoring.cumulative24hThreshold,
        timeWindow: 24, // 24小时滚动窗口
        enabled: true,
      },
    ];

    logger.info('预警引擎初始化完成', {
      rulesCount: this.rules.length,
      addressCount: this.addressMap.size,
      rules: this.rules.map(r => ({ id: r.id, type: r.type, threshold: r.threshold, enabled: r.enabled }))
    });
  }

  async processEvent(event: MonitorEvent): Promise<void> {
    try {
      const addressInfo = this.addressMap.get(event.address.toLowerCase());
      
      if (!addressInfo) {
        logger.debug('未找到地址配置，跳过预警检查', { address: event.address });
        return;
      }

      if (!addressInfo.isActive) {
        logger.debug('地址监控已禁用，跳过预警检查', { address: event.address, label: addressInfo.label });
        return;
      }

      logger.debug('处理监控事件', {
        address: event.address,
        label: addressInfo.label,
        eventType: event.eventType,
        amount: event.amount
      });

      // 🔧 新的优先级处理逻辑：优先检查累计转账，避免重复警报
      const cumulativeTriggered = await this.checkCumulativeTransferAlert(event, addressInfo);
      
      // 只有当累计转账没有触发时，才检查单笔转账
      if (!cumulativeTriggered) {
        await this.checkSingleTransferAlert(event, addressInfo);
      } else {
        logger.info('🔕 累计转账警报已触发，跳过单笔转账警报', {
          address: event.address,
          label: addressInfo.label,
          amount: event.amount,
          reason: '避免重复警报'
        });
      }

    } catch (error) {
      logger.error('处理预警事件失败:', error, { event });
    }
  }

  private async checkSingleTransferAlert(event: MonitorEvent, addressInfo: WatchedAddress): Promise<void> {
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
        unlockAmount: addressInfo.unlockAmount > 0 ? addressInfo.unlockAmount : undefined,
      };

      logger.info('触发单笔转账预警', {
        address: event.address,
        label: addressInfo.label,
        amount: event.amount,
        threshold,
        alertType
      });

      await this.notifier.sendAlert(alert);
    }
  }

  private async checkCumulativeTransferAlert(event: MonitorEvent, addressInfo: WatchedAddress): Promise<boolean> {
    const rule = this.rules.find(r => r.type === 'cumulative_transfer' && r.enabled);
    if (!rule) return false;

    // 更新累计缓存
    await this.cache.updateDailyCache(event.address, event);

    // 获取累计数据
    const dailyCache = await this.cache.getDailyCache(event.address);
    if (!dailyCache) return false;

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
        addressLabel: addressInfo.label,
        amount: event.amount,
        txHash: event.hash,
        blockTime: event.blockTime,
        cumulativeToday: direction === 'in' ? dailyCache.totalInbound : dailyCache.totalOutbound,
        unlockAmount: addressInfo.unlockAmount > 0 ? addressInfo.unlockAmount : undefined,
      };

      logger.info('触发累计转账预警', {
        address: event.address,
        label: addressInfo.label,
        currentAmount: event.amount,
        cumulativeAmount,
        threshold,
        alertType,
        direction
      });

      await this.notifier.sendAlert(alert);
      return true; // 返回true表示累计警报已触发
    }
    
    return false; // 返回false表示累计警报未触发
  }

  // 获取统计数据
  async getStats(): Promise<{
    totalRules: number;
    activeRules: number;
    totalAddresses: number;
    activeAddresses: number;
  }> {
    const activeRules = this.rules.filter(r => r.enabled).length;
    const activeAddresses = Array.from(this.addressMap.values()).filter(addr => addr.isActive).length;

    return {
      totalRules: this.rules.length,
      activeRules,
      totalAddresses: this.addressMap.size,
      activeAddresses,
    };
  }

  // 添加或更新预警规则
  addRule(rule: AlertRule): void {
    const existingIndex = this.rules.findIndex(r => r.id === rule.id);
    if (existingIndex >= 0) {
      this.rules[existingIndex] = rule;
      logger.info('预警规则已更新', { ruleId: rule.id, type: rule.type });
    } else {
      this.rules.push(rule);
      logger.info('预警规则已添加', { ruleId: rule.id, type: rule.type });
    }
  }

  // 启用/禁用预警规则
  toggleRule(ruleId: string, enabled: boolean): void {
    const rule = this.rules.find(r => r.id === ruleId);
    if (rule) {
      rule.enabled = enabled;
      logger.info('预警规则状态已更新', { ruleId, enabled });
    }
  }

  // 获取所有规则
  getRules(): AlertRule[] {
    return [...this.rules];
  }

  // 获取地址配置
  getAddresses(): WatchedAddress[] {
    return Array.from(this.addressMap.values());
  }
}

export default AlertEngine;
