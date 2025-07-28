import { MonitorEvent } from '../types';
import logger from '../logger';
import { SYSTEM_START_TIME } from '../index';

// WebSocket数据解析器
export class HyperliquidDataParser {
  
  // 需要过滤掉的事件类型（订单相关）
  private static readonly FILTERED_EVENT_TYPES = [
    'modify',
    'batchModify', 
    'cancel',
    'batchCancel',
    'order',
    'placeOrder',
    'liquidation',
    'funding'
  ];

  // 解析用户事件数据 - 只处理真正的转账和成交
  static parseUserEvents(data: any, address: string): MonitorEvent[] {
    const events: MonitorEvent[] = [];
    
    try {
      // 1. 首先过滤掉订单相关事件
      if (this.isOrderRelatedEvent(data)) {
        logger.debug('过滤掉订单相关事件', { 
          eventKeys: Object.keys(data),
          address: address.substring(0, 10) + '...'
        });
        return events;
      }

      // 2. 只处理填充（成交）事件
      if (data && data.fills) {
        for (const fill of data.fills) {
          if (this.isHypeFill(fill)) {
            // 🔥 新增：检查事件时间，过滤历史事件
            if (this.isHistoricalEvent(fill.time)) {
              logger.debug('跳过历史成交事件', { 
                fillTime: new Date(fill.time).toISOString(),
                hash: fill.hash?.substring(0, 10) + '...'
              });
              continue;
            }

            const event = this.parseHypeFill(fill, address);
            if (event) events.push(event);
          }
        }
      }
      
    } catch (error) {
      logger.error('解析用户事件失败:', error);
    }
    
    return events;
  }

  // 解析账本更新数据（专注于转账监控）
  static parseUserNonFundingLedgerUpdates(data: any, address: string): MonitorEvent[] {
    const events: MonitorEvent[] = [];
    
    try {
      if (!data || !data.nonFundingLedgerUpdates) return events;
      
      for (const update of data.nonFundingLedgerUpdates) {
        // 🔥 新增：检查事件时间，过滤历史事件
        if (this.isHistoricalEvent(update.time)) {
          logger.debug('跳过历史账本更新事件', { 
            updateTime: new Date(update.time).toISOString(),
            hash: update.hash?.substring(0, 10) + '...',
            type: update.delta?.type
          });
          continue;
        }

        // 只处理转账相关的账本更新
        if (this.isTransferRelatedUpdate(update)) {
          const event = this.parseLedgerUpdate(update, address);
          if (event) events.push(event);
        }
      }
      
    } catch (error) {
      logger.error('解析账本更新失败:', error);
    }
    
    return events;
  }

  // ===== 新增：检查是否是订单相关事件 =====
  private static isOrderRelatedEvent(data: any): boolean {
    if (!data || typeof data !== 'object') return false;

    // 检查数据中是否包含订单相关的键
    const dataKeys = Object.keys(data);
    
    for (const key of dataKeys) {
      // 检查是否包含订单相关的类型
      if (this.FILTERED_EVENT_TYPES.some(filteredType => 
        key.toLowerCase().includes(filteredType.toLowerCase())
      )) {
        return true;
      }

      // 检查嵌套对象中是否有订单相关内容
      if (data[key] && typeof data[key] === 'object') {
        if (data[key].type && this.FILTERED_EVENT_TYPES.includes(data[key].type)) {
          return true;
        }
      }
    }

    return false;
  }

  // ===== 新增：检查是否是转账相关的账本更新 =====
  private static isTransferRelatedUpdate(update: any): boolean {
    if (!update || !update.delta) return false;

    const transferTypes = [
      'spotTransfer',     // 现货转账
      'deposit',          // 存款
      'withdraw',         // 取款
      'spotGenesis',      // 现货创世
      'usdTransfer'       // USD转账
    ];

    return transferTypes.includes(update.delta.type);
  }

  // ===== 修复：检查是否是历史事件 =====
  private static isHistoricalEvent(eventTime: number): boolean {
    if (!eventTime) {
      logger.debug('事件时间为空，跳过');
      return true; // 没有时间的事件认为是无效的
    }
    
    // 使用导入的系统启动时间
    const systemStartTime = SYSTEM_START_TIME;
    const isHistorical = eventTime < systemStartTime;
    
    if (isHistorical) {
      const timeDiff = Math.round((systemStartTime - eventTime) / 1000);
      logger.debug('🔄 检测到历史事件', {
        eventTime: new Date(eventTime).toISOString(),
        systemStartTime: new Date(systemStartTime).toISOString(),
        timeDiffSeconds: timeDiff,
        timeDiffMinutes: Math.round(timeDiff / 60)
      });
    }
    
    return isHistorical;
  }
  // 判断是否是HYPE相关的成交
  private static isHypeFill(fill: any): boolean {
    // @107 是HYPE的资产索引
    return fill.coin === '@107' || fill.coin === 'HYPE';
  }

  // 解析HYPE成交数据 - 只监控买入
  private static parseHypeFill(fill: any, address: string): MonitorEvent | null {
    try {
      const amount = parseFloat(fill.sz);
      const price = parseFloat(fill.px);
      const usdValue = amount * price;
      
      // 只监控买入交易（转入相当于买入）
      const isBuy = fill.side === 'B';
      if (!isBuy) {
        logger.debug('跳过卖出交易', { amount, side: fill.side });
        return null;
      }
      
      return {
        timestamp: Date.now(),
        address,
        eventType: 'trade_buy',
        amount: amount.toString(),
        hash: fill.hash || `fill_${fill.tid}`,
        blockTime: this.normalizeTimestamp(fill.time),
        asset: 'HYPE',
        metadata: {
          price: price.toString(),
          usdValue: usdValue.toString(),
          side: fill.side,
          type: 'spot_trade'
        }
      };
      
    } catch (error) {
      logger.error('解析HYPE成交失败:', error);
      return null;
    }
  }

  // 解析账本更新（转账、存取款等）
  private static parseLedgerUpdate(update: any, address: string): MonitorEvent | null {
    try {
      const { delta, time, hash } = update;
      
      if (!delta) return null;

      // 只解析转账相关类型
      switch (delta.type) {
        case 'spotTransfer':
          return this.parseSpotTransfer(delta, address, time, hash);
        case 'deposit':
          return this.parseDeposit(delta, address, time, hash);
        case 'withdraw':
          return this.parseWithdraw(delta, address, time, hash);
        default:
          logger.debug('跳过非转账类型的账本更新', { type: delta.type });
          return null;
      }
      
    } catch (error) {
      logger.error('解析账本更新失败:', error);
      return null;
    }
  }

  // 解析现货转账
  private static parseSpotTransfer(delta: any, address: string, time: number, hash: string): MonitorEvent | null {
    // 只处理HYPE代币转账
    if (delta.token !== 'HYPE') {
      logger.debug('跳过非HYPE代币转账', { token: delta.token });
      return null;
    }
    
    const amount = parseFloat(delta.amount);
    const isIncoming = delta.destination === address;
    const isOutgoing = delta.user === address;
    
    let eventType: MonitorEvent['eventType'];
    if (isIncoming) {
      eventType = 'transfer_in';
    } else if (isOutgoing) {
      eventType = 'transfer_out';
    } else {
      return null; // 不是该地址的转账
    }

    return {
      timestamp: Date.now(),
      address,
      eventType,
      amount: amount.toString(),
      hash,
      blockTime: this.normalizeTimestamp(time),
      asset: 'HYPE',
      metadata: {
        usdValue: delta.usdcValue || '0',
        fee: delta.fee || '0',
        counterparty: isIncoming ? delta.user : delta.destination,
        type: 'spot_transfer'
      }
    };
  }

  // ===== 新增：解析存款 =====
  private static parseDeposit(delta: any, address: string, time: number, hash: string): MonitorEvent | null {
    if (delta.token !== 'HYPE') return null;
    
    const amount = parseFloat(delta.amount);
    
    return {
      timestamp: Date.now(),
      address,
      eventType: 'deposit',
      amount: amount.toString(),
      hash,
      blockTime: this.normalizeTimestamp(time),
      asset: 'HYPE',
      metadata: {
        usdValue: delta.usdcValue || '0',
        type: 'deposit'
      }
    };
  }

  // ===== 新增：解析取款 =====
  private static parseWithdraw(delta: any, address: string, time: number, hash: string): MonitorEvent | null {
    if (delta.token !== 'HYPE') return null;
    
    const amount = parseFloat(delta.amount);
    
    return {
      timestamp: Date.now(),
      address,
      eventType: 'withdraw',
      amount: amount.toString(),
      hash,
      blockTime: this.normalizeTimestamp(time),
      asset: 'HYPE',
      metadata: {
        usdValue: delta.usdcValue || '0',
        type: 'withdraw'
      }
    };
  }

  // 过滤出HYPE相关事件
  static filterHypeEvents(events: MonitorEvent[]): MonitorEvent[] {
    return events.filter(event => 
      event.asset === 'HYPE' && 
      this.isValidTransferEvent(event)
    );
  }

  // ===== 新增：验证是否是有效的转账事件 =====
  private static isValidTransferEvent(event: MonitorEvent): boolean {
    const validTypes = [
      'transfer_in',
      'transfer_out',
      'deposit',
      'withdraw',
      'trade_buy'  // 只监控买入，不监控卖出
    ];
    
    return validTypes.includes(event.eventType);
  }

  // 判断事件是否应该触发监控
  static shouldMonitorEvent(event: MonitorEvent): boolean {
    const monitoredTypes = [
      'transfer_in',
      'transfer_out', 
      'deposit',
      'withdraw',
      'trade_buy'  // 移除 trade_sell
    ];
    
    const amount = parseFloat(event.amount);
    
    return monitoredTypes.includes(event.eventType) && 
           amount > 0 &&
           event.asset === 'HYPE';
  }

  // 创建事件摘要用于日志
  static createEventSummary(event: MonitorEvent): string {
    const amount = parseFloat(event.amount).toLocaleString();
    const type = event.eventType.replace('_', ' ');
    return `${type}: ${amount} ${event.asset}`;
  }

  // 标准化时间戳 - 统一转换为毫秒级时间戳
  private static normalizeTimestamp(timestamp: number): number {
    if (!timestamp) {
      return Date.now();
    }
    
    // 如果是微秒级时间戳（大于10^15），转换为毫秒
    if (timestamp > 1e15) {
      return Math.floor(timestamp / 1000);
    }
    
    // 如果是秒级时间戳（小于10^12），转换为毫秒
    if (timestamp < 1e12) {
      return timestamp * 1000;
    }
    
    // 否则认为已经是毫秒级时间戳
    return timestamp;
  }
}

export default HyperliquidDataParser;