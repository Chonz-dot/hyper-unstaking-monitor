import { MonitorEvent } from '../types';
import logger from '../logger';

// 获取系统启动时间
const SYSTEM_START_TIME = Date.now();

// WebSocket数据解析器
export class HyperliquidDataParser {
  
  // 需要过滤掉的事件类型（订单相关）
  private static readonly FILTERED_EVENT_TYPES = [
    'modify',
    'cancel',
    'triggered',
    'ack',
    'err',
    'partialFill',
    'marginChange',
    'leverage',
    'isolated_margin'
  ];

  // 解析WebSocket数据
  static parseWebSocketData(data: any, address: string): MonitorEvent[] {
    const events: MonitorEvent[] = [];

    try {
      if (!data || typeof data !== 'object') {
        return events;
      }

      // 调试日志
      logger.debug('解析WebSocket数据', {
        address: address.slice(0, 8) + '...',
        dataKeys: Object.keys(data),
        dataType: typeof data
      });

      // 处理不同类型的WebSocket消息
      if (data.channel && data.data) {
        // 标准WebSocket消息格式
        events.push(...this.parseChannelData(data, address));
      } else if (Array.isArray(data)) {
        // 数组格式的数据
        for (const item of data) {
          events.push(...this.parseWebSocketData(item, address));
        }
      } else {
        // 直接数据格式
        events.push(...this.parseDirectData(data, address));
      }

    } catch (error) {
      logger.error('解析WebSocket数据失败:', error, { address, data: JSON.stringify(data).slice(0, 200) });
    }

    return events;
  }

  // 解析频道数据
  private static parseChannelData(data: any, address: string): MonitorEvent[] {
    const events: MonitorEvent[] = [];

    try {
      const { channel, data: channelData } = data;

      switch (channel) {
        case 'subscriptionResponse':
          // 订阅确认，不处理
          break;
        
        case 'notification':
          // 通知消息
          events.push(...this.parseNotificationData(channelData, address));
          break;
          
        case 'userEvents':
          // 用户事件
          events.push(...this.parseUserEvents(channelData, address));
          break;
          
        case 'webData2':
          // Web数据
          events.push(...this.parseWebData(channelData, address));
          break;
          
        case 'userFills':
          // 用户成交
          events.push(...this.parseUserFills(channelData, address));
          break;
          
        case 'userNonFundingLedgerUpdates':
          // 非资金账本更新
          events.push(...this.parseNonFundingLedger(channelData, address));
          break;
          
        default:
          logger.debug('未知频道类型', { channel, address });
      }

    } catch (error) {
      logger.error('解析频道数据失败:', error, { address, data });
    }

    return events;
  }

  // 解析直接数据
  private static parseDirectData(data: any, address: string): MonitorEvent[] {
    const events: MonitorEvent[] = [];

    // 检查是否为转账相关数据
    if (data.type === 'transfer' || data.type === 'transaction') {
      events.push(...this.parseTransferData(data, address));
    }

    // 检查是否为交易数据
    if (data.type === 'trade' || data.fills) {
      events.push(...this.parseTradeData(data, address));
    }

    // 检查是否为账本更新
    if (data.type === 'ledgerUpdate' || data.delta) {
      events.push(...this.parseLedgerUpdate(data, address));
    }

    return events;
  }

  // 解析通知数据
  private static parseNotificationData(data: any, address: string): MonitorEvent[] {
    const events: MonitorEvent[] = [];

    if (data.notification && typeof data.notification === 'string') {
      // 检查通知内容是否包含转账信息
      const notification = data.notification.toLowerCase();
      
      if (notification.includes('transfer') || notification.includes('withdraw') || notification.includes('deposit')) {
        logger.debug('收到转账通知', { address, notification: data.notification });
        
        // 尝试从通知中提取转账信息
        const transferInfo = this.extractTransferFromNotification(data.notification);
        if (transferInfo) {
          events.push(this.createMonitorEvent(
            transferInfo.type,
            transferInfo.amount,
            transferInfo.hash || 'notification_' + Date.now(),
            address,
            transferInfo.blockTime || Math.floor(Date.now() / 1000),
            { source: 'notification', notification: data.notification }
          ));
        }
      }
    }

    return events;
  }

  // 解析用户事件
  static parseUserEvents(data: any, address: string): MonitorEvent[] {
    const events: MonitorEvent[] = [];

    if (data.fills && Array.isArray(data.fills)) {
      // 交易成交
      for (const fill of data.fills) {
        if (fill.coin === 'HYPE' || fill.coin?.includes('HYPE')) {
          const event = this.createMonitorEvent(
            'trade_buy',
            fill.sz || '0',
            fill.hash || fill.tid || 'fill_' + Date.now(),
            address,
            fill.time ? Math.floor(fill.time / 1000) : Math.floor(Date.now() / 1000),
            {
              source: 'userEvents',
              price: fill.px,
              side: fill.side,
              originalAsset: fill.coin
            }
          );
          events.push(event);
        }
      }
    }

    if (data.funding) {
      // 资金费用，一般不作为转账处理
      logger.debug('收到资金费用事件', { address, funding: data.funding });
    }

    if (data.liquidation) {
      // 清算事件
      logger.debug('收到清算事件', { address, liquidation: data.liquidation });
    }

    return events;
  }

  // 解析Web数据
  private static parseWebData(data: any, address: string): MonitorEvent[] {
    const events: MonitorEvent[] = [];

    // WebData2通常包含聚合的用户数据
    if (data.assetPositions) {
      // 资产持仓变化
      for (const position of data.assetPositions) {
        if (position.position && position.position.coin === 'HYPE') {
          logger.debug('HYPE持仓变化', { address, position });
        }
      }
    }

    return events;
  }

  // 解析用户成交
  private static parseUserFills(data: any, address: string): MonitorEvent[] {
    const events: MonitorEvent[] = [];

    if (data.fills && Array.isArray(data.fills)) {
      for (const fill of data.fills) {
        if (fill.coin === 'HYPE' || fill.coin?.includes('HYPE')) {
          // 检查是否为真实的转账而非交易
          const isTransfer = !fill.px || fill.px === '0'; // 没有价格表示可能是转账
          
          const eventType = isTransfer ? 
            (parseFloat(fill.sz) > 0 ? 'transfer_in' : 'transfer_out') :
            'trade_buy';

          const event = this.createMonitorEvent(
            eventType,
            Math.abs(parseFloat(fill.sz)).toString(),
            fill.hash || fill.tid || 'fill_' + Date.now(),
            address,
            fill.time ? Math.floor(fill.time / 1000) : Math.floor(Date.now() / 1000),
            {
              source: 'userFills',
              price: fill.px,
              side: fill.side,
              originalAsset: fill.coin,
              isRealTime: true
            }
          );
          events.push(event);
        }
      }
    }

    return events;
  }

  // 解析非资金账本更新
  private static parseNonFundingLedger(data: any, address: string): MonitorEvent[] {
    const events: MonitorEvent[] = [];

    if (data.delta && data.delta.type) {
      const delta = data.delta;
      
      switch (delta.type) {
        case 'deposit':
          if (delta.usdc && parseFloat(delta.usdc) > 0) {
            events.push(this.createMonitorEvent(
              'deposit',
              delta.usdc.toString(),
              data.hash || 'deposit_' + Date.now(),
              address,
              data.time ? Math.floor(data.time / 1000) : Math.floor(Date.now() / 1000),
              {
                source: 'nonFundingLedger',
                usdValue: delta.usdc,
                originalAsset: 'USDC'
              }
            ));
          }
          break;
          
        case 'withdraw':
          if (delta.usdc && parseFloat(delta.usdc) > 0) {
            events.push(this.createMonitorEvent(
              'withdraw',
              delta.usdc.toString(),
              data.hash || 'withdraw_' + Date.now(),
              address,
              data.time ? Math.floor(data.time / 1000) : Math.floor(Date.now() / 1000),
              {
                source: 'nonFundingLedger',
                usdValue: delta.usdc,
                originalAsset: 'USDC'
              }
            ));
          }
          break;
      }
    }

    return events;
  }

  // 解析转账数据
  private static parseTransferData(data: any, address: string): MonitorEvent[] {
    const events: MonitorEvent[] = [];

    // 处理具体的转账数据格式
    if (data.amount && data.asset === 'HYPE') {
      const event = this.createMonitorEvent(
        data.direction === 'in' ? 'transfer_in' : 'transfer_out',
        data.amount,
        data.hash || data.txHash || 'transfer_' + Date.now(),
        address,
        data.blockTime || Math.floor(Date.now() / 1000),
        { source: 'transfer', asset: data.asset }
      );
      events.push(event);
    }

    return events;
  }

  // 解析交易数据
  private static parseTradeData(data: any, address: string): MonitorEvent[] {
    const events: MonitorEvent[] = [];

    if (data.asset === 'HYPE' && data.amount) {
      const event = this.createMonitorEvent(
        'trade_buy',
        data.amount,
        data.hash || 'trade_' + Date.now(),
        address,
        data.blockTime || Math.floor(Date.now() / 1000),
        { source: 'trade', price: data.price, asset: data.asset }
      );
      events.push(event);
    }

    return events;
  }

  // 解析账本更新
  private static parseLedgerUpdate(data: any, address: string): MonitorEvent[] {
    const events: MonitorEvent[] = [];

    if (data.delta && data.delta.amount && data.delta.asset === 'HYPE') {
      const eventType = parseFloat(data.delta.amount) > 0 ? 'transfer_in' : 'transfer_out';
      
      const event = this.createMonitorEvent(
        eventType,
        Math.abs(parseFloat(data.delta.amount)).toString(),
        data.hash || 'ledger_' + Date.now(),
        address,
        data.time || Math.floor(Date.now() / 1000),
        { source: 'ledger', asset: data.delta.asset }
      );
      events.push(event);
    }

    return events;
  }

  // 从通知中提取转账信息
  private static extractTransferFromNotification(notification: string): {
    type: 'transfer_in' | 'transfer_out',
    amount: string,
    hash?: string,
    blockTime?: number
  } | null {
    
    // 简单的正则匹配来提取转账信息
    const transferMatch = notification.match(/transfer.*([\d,]+\.?\d*)\s*HYPE/i);
    const withdrawMatch = notification.match(/withdraw.*([\d,]+\.?\d*)\s*HYPE/i);
    const depositMatch = notification.match(/deposit.*([\d,]+\.?\d*)\s*HYPE/i);
    
    if (transferMatch) {
      const amount = transferMatch[1].replace(/,/g, '');
      return {
        type: notification.toLowerCase().includes('receive') ? 'transfer_in' : 'transfer_out',
        amount,
        blockTime: Math.floor(Date.now() / 1000)
      };
    }
    
    if (withdrawMatch) {
      const amount = withdrawMatch[1].replace(/,/g, '');
      return {
        type: 'transfer_out',
        amount,
        blockTime: Math.floor(Date.now() / 1000)
      };
    }
    
    if (depositMatch) {
      const amount = depositMatch[1].replace(/,/g, '');
      return {
        type: 'transfer_in',
        amount,
        blockTime: Math.floor(Date.now() / 1000)
      };
    }
    
    return null;
  }

  // 创建监控事件
  private static createMonitorEvent(
    eventType: string,
    amount: string,
    hash: string,
    address: string,
    blockTime: number,
    metadata: any = {}
  ): MonitorEvent {
    return {
      timestamp: Date.now(),
      address,
      eventType: eventType as any,
      amount,
      hash,
      blockTime,
      asset: metadata.originalAsset || metadata.asset || 'HYPE',
      metadata: {
        ...metadata,
        isRealTime: true
      }
    };
  }

  // 过滤无关事件
  static shouldFilterEvent(data: any): boolean {
    if (!data || typeof data !== 'object') {
      return true;
    }

    // 过滤掉订单相关事件
    if (data.type && this.FILTERED_EVENT_TYPES.includes(data.type)) {
      return true;
    }

    // 过滤掉非HYPE相关事件
    if (data.coin && !data.coin.includes('HYPE')) {
      return true;
    }

    return false;
  }

  // 验证事件有效性
  static isValidEvent(event: MonitorEvent): boolean {
    // 检查必要字段
    if (!event.address || !event.amount || !event.hash || !event.eventType) {
      return false;
    }

    // 检查金额是否有效
    const amount = parseFloat(event.amount);
    if (isNaN(amount) || amount <= 0) {
      return false;
    }

    // 检查地址格式
    if (!event.address.startsWith('0x') || event.address.length !== 42) {
      return false;
    }

    return true;
  }

  // 过滤HYPE相关事件
  static filterHypeEvents(events: MonitorEvent[]): MonitorEvent[] {
    return events.filter(event => {
      // 检查资产是否为HYPE
      if (event.asset && event.asset.toUpperCase().includes('HYPE')) {
        return true;
      }
      
      // 检查元数据中的原始资产
      if (event.metadata?.originalAsset && 
          event.metadata.originalAsset.toUpperCase().includes('HYPE')) {
        return true;
      }
      
      return false;
    });
  }

  // 判断是否应该监控事件
  static shouldMonitorEvent(event: MonitorEvent): boolean {
    // 与shouldFilterEvent相反的逻辑
    if (this.shouldFilterEvent(event)) {
      return false;
    }

    // 验证事件有效性
    if (!this.isValidEvent(event)) {
      return false;
    }

    // 检查是否为HYPE相关
    const isHypeRelated = event.asset?.toUpperCase().includes('HYPE') || 
                         event.metadata?.originalAsset?.toUpperCase().includes('HYPE');
    
    if (!isHypeRelated) {
      return false;
    }

    // 检查金额是否足够大（避免粉尘攻击）
    const amount = parseFloat(event.amount);
    if (amount < 0.01) { // 最小监控金额
      return false;
    }

    return true;
  }

  // 创建事件摘要
  static createEventSummary(event: MonitorEvent): string {
    const amount = parseFloat(event.amount).toFixed(4);
    const address = event.address.slice(0, 8) + '...';
    
    switch (event.eventType) {
      case 'transfer_in':
        return `${address} 收到 ${amount} HYPE`;
      case 'transfer_out':
        return `${address} 转出 ${amount} HYPE`;
      case 'trade_buy':
        const price = event.metadata?.price ? ` @$${event.metadata.price}` : '';
        return `${address} 买入 ${amount} HYPE${price}`;
      case 'deposit':
        return `${address} 存入 ${amount} HYPE`;
      case 'withdraw':
        return `${address} 提取 ${amount} HYPE`;
      default:
        return `${address} ${event.eventType} ${amount} HYPE`;
    }
  }

  // 解析用户非资金账本更新
  static parseUserNonFundingLedgerUpdates(data: any, address: string): MonitorEvent[] {
    const events: MonitorEvent[] = [];

    try {
      // 处理nonFundingLedgerUpdates数组
      if (data.nonFundingLedgerUpdates && Array.isArray(data.nonFundingLedgerUpdates)) {
        for (const update of data.nonFundingLedgerUpdates) {
          if (update.delta && update.delta.type) {
            const delta = update.delta;
            
            // 检查是否为HYPE相关的更新
            let amount = '0';
            let eventType = 'unknown';
            let metadata: any = { source: 'nonFundingLedger' };

            switch (delta.type) {
              case 'deposit':
                if (delta.usdc && parseFloat(delta.usdc) > 0) {
                  amount = delta.usdc.toString();
                  eventType = 'deposit';
                  metadata.usdValue = delta.usdc;
                  metadata.originalAsset = 'USDC';
                }
                break;
                
              case 'withdraw':
                if (delta.usdc && parseFloat(delta.usdc) > 0) {
                  amount = delta.usdc.toString();
                  eventType = 'withdraw';
                  metadata.usdValue = delta.usdc;
                  metadata.originalAsset = 'USDC';
                }
                break;

              case 'spotGenesis':
                // 现货创世事件
                if (delta.token && delta.token.includes('HYPE')) {
                  amount = delta.amount || '0';
                  eventType = 'transfer_in';
                  metadata.originalAsset = 'HYPE';
                  metadata.eventSubType = 'spotGenesis';
                }
                break;

              case 'internalTransfer':
                // 内部转账
                if (delta.coin && delta.coin.includes('HYPE')) {
                  amount = Math.abs(parseFloat(delta.amount || '0')).toString();
                  eventType = parseFloat(delta.amount || '0') > 0 ? 'transfer_in' : 'transfer_out';
                  metadata.originalAsset = delta.coin;
                  metadata.counterparty = delta.user;
                }
                break;
            }

            if (amount !== '0' && eventType !== 'unknown') {
              const event = this.createMonitorEvent(
                eventType,
                amount,
                update.hash || update.time + '_' + delta.type,
                address,
                update.time ? Math.floor(update.time / 1000) : Math.floor(Date.now() / 1000),
                metadata
              );
              events.push(event);
            }
          }
        }
      }
      // 兼容其他格式
      else if (data.delta) {
        events.push(...this.parseNonFundingLedger(data, address));
      }

    } catch (error) {
      logger.error('解析非资金账本更新失败:', error, { address, data: JSON.stringify(data).slice(0, 200) });
    }

    return events;
  }
}

export default HyperliquidDataParser;
