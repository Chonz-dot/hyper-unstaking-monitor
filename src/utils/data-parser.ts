import { MonitorEvent } from '../types';
import logger from '../logger';

// WebSocket数据解析器
export class HyperliquidDataParser {
  
  // 解析用户事件数据
  static parseUserEvents(data: any, address: string): MonitorEvent[] {
    const events: MonitorEvent[] = [];
    
    try {
      if (!data || !data.fills) return events;
      
      // 解析用户成交数据中的HYPE交易
      for (const fill of data.fills) {
        if (this.isHypeFill(fill)) {
          const event = this.parseHypeFill(fill, address);
          if (event) events.push(event);
        }
      }
      
    } catch (error) {
      logger.error('解析用户事件失败:', error);
    }
    
    return events;
  }

  // 解析账本更新数据（主要用于转账监控）
  static parseUserNonFundingLedgerUpdates(data: any, address: string): MonitorEvent[] {
    const events: MonitorEvent[] = [];
    
    try {
      if (!data || !data.nonFundingLedgerUpdates) return events;
      
      for (const update of data.nonFundingLedgerUpdates) {
        const event = this.parseLedgerUpdate(update, address);
        if (event) events.push(event);
      }
      
    } catch (error) {
      logger.error('解析账本更新失败:', error);
    }
    
    return events;
  }

  // 判断是否是HYPE相关的成交
  private static isHypeFill(fill: any): boolean {
    // @107 是HYPE的资产索引（从日志中观察到）
    return fill.coin === '@107' || fill.coin === 'HYPE';
  }

  // 解析HYPE成交数据
  private static parseHypeFill(fill: any, address: string): MonitorEvent | null {
    try {
      const amount = parseFloat(fill.sz);
      const price = parseFloat(fill.px);
      const usdValue = amount * price;
      
      // 判断买卖方向
      const isBuy = fill.side === 'B';
      
      return {
        timestamp: Date.now(),
        address,
        eventType: isBuy ? 'trade_buy' : 'trade_sell',
        amount: amount.toString(),
        hash: fill.hash || `fill_${fill.tid}`,
        blockTime: fill.time,
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

      // 解析不同类型的更新
      switch (delta.type) {
        case 'spotTransfer':
          return this.parseSpotTransfer(delta, address, time, hash);
        default:
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
    if (delta.token !== 'HYPE') return null;
    
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
      blockTime: time,
      asset: 'HYPE',
      metadata: {
        usdValue: delta.usdcValue || '0',
        fee: delta.fee || '0',
        counterparty: isIncoming ? delta.user : delta.destination,
        type: 'spot_transfer'
      }
    };
  }

  // 过滤出HYPE相关事件
  static filterHypeEvents(events: MonitorEvent[]): MonitorEvent[] {
    return events.filter(event => 
      event.asset === 'HYPE' || 
      event.eventType.includes('transfer') ||
      event.eventType === 'trade_buy'
    );
  }

  // 判断事件是否应该触发监控
  static shouldMonitorEvent(event: MonitorEvent): boolean {
    const monitoredTypes = [
      'transfer_in',
      'transfer_out', 
      'trade_buy',
      'trade_sell'
    ];
    
    return monitoredTypes.includes(event.eventType) && 
           parseFloat(event.amount) > 0;
  }

  // 创建事件摘要用于日志
  static createEventSummary(event: MonitorEvent): string {
    const amount = parseFloat(event.amount).toLocaleString();
    const type = event.eventType.replace('_', ' ');
    return `${type}: ${amount} ${event.asset}`;
  }
}

export default HyperliquidDataParser;
