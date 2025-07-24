import { EventEmitter } from 'events';
import * as hl from '@nktkas/hyperliquid';
import { logger } from '../logger';
import { ContractEvent, ContractTrader, ContractWebhookAlert } from '../types';

export class ContractMonitor extends EventEmitter {
  private client: hl.SubscriptionClient | null = null;
  private transport: hl.WebSocketTransport | null = null;
  private traders: ContractTrader[];
  private activeSubscriptions = new Map<string, any>();
  private minNotionalValue: number;
  private watchedAssets?: string[];

  constructor(
    traders: ContractTrader[],
    minNotionalValue: number = 1000,
    watchedAssets?: string[]
  ) {
    super();
    this.traders = traders.filter(trader => trader.isActive);
    this.minNotionalValue = minNotionalValue;
    this.watchedAssets = watchedAssets;

    logger.info('合约监控器初始化', {
      tradersCount: this.traders.length,
      minNotionalValue,
      watchedAssets: watchedAssets || '全部资产'
    });
  }

  async start(wsUrl: string): Promise<void> {
    try {
      // 创建WebSocket传输
      this.transport = new hl.WebSocketTransport({
        url: wsUrl
      });

      // 创建订阅客户端
      this.client = new hl.SubscriptionClient({
        transport: this.transport
      });

      logger.info('合约监控WebSocket连接初始化');

      // 为每个交易员订阅事件
      for (const trader of this.traders) {
        await this.subscribeToTrader(trader);
      }

      logger.info('合约监控已启动', {
        activeTraders: this.traders.length,
        subscriptions: this.activeSubscriptions.size
      });

    } catch (error) {
      logger.error('合约监控器启动失败', error);
      throw error;
    }
  }

  private async subscribeToTrader(trader: ContractTrader): Promise<void> {
    if (!this.client) {
      throw new Error('WebSocket客户端未初始化');
    }

    try {
      // 订阅用户填充/成交信息
      const fillsSubscription = await this.client.userFills(
        { user: trader.address as `0x${string}` },
        (data) => {
          this.handleUserFills(data, trader);
        }
      );

      // 订阅用户事件
      const eventsSubscription = await this.client.userEvents(
        { user: trader.address as `0x${string}` },
        (data) => {
          this.handleUserEvents(data, trader);
        }
      );

      // 订阅WebData2获取持仓信息
      const webData2Subscription = await this.client.webData2(
        { user: trader.address as `0x${string}` },
        (data) => {
          this.handleWebData2(data, trader);
        }
      );

      this.activeSubscriptions.set(`${trader.address}_fills`, fillsSubscription);
      this.activeSubscriptions.set(`${trader.address}_events`, eventsSubscription);
      this.activeSubscriptions.set(`${trader.address}_webdata2`, webData2Subscription);

      logger.info(`已订阅交易员 ${trader.label} (${trader.address}) 的合约信号`);

    } catch (error) {
      logger.error(`订阅交易员 ${trader.label} 失败`, error);
    }
  }

  private handleUserFills(data: any, trader: ContractTrader): void {
    try {
      // 处理用户成交数据
      if (data && Array.isArray(data.fills)) {
        for (const fill of data.fills) {
          this.processTradeFill(fill, trader);
        }
      } else if (data && data.fills) {
        this.processTradeFill(data.fills, trader);
      }
    } catch (error) {
      logger.error(`处理用户成交失败 - ${trader.label}`, error);
    }
  }

  private handleUserEvents(data: any, trader: ContractTrader): void {
    try {
      // 处理用户事件数据
      if (data && data.data) {
        this.processUserEvent(data.data, trader);
      }
    } catch (error) {
      logger.error(`处理用户事件失败 - ${trader.label}`, error);
    }
  }

  private handleWebData2(data: any, trader: ContractTrader): void {
    try {
      // 处理持仓变化
      if (data && data.assetPositions) {
        for (const position of data.assetPositions) {
          if (position.position && position.position.szi !== "0") {
            this.processPositionUpdate(position, trader);
          }
        }
      }
    } catch (error) {
      logger.error(`处理持仓更新失败 - ${trader.label}`, error);
    }
  }

  private processTradeFill(fill: any, trader: ContractTrader): void {
    try {
      let transactionHash = '';
      let explorerUrl = '';

      const asset = fill.coin;
      const size = Math.abs(parseFloat(fill.sz || '0'));
      const price = parseFloat(fill.px || '0');
      const side = fill.side === 'B' ? 'long' : 'short';
      const isOpening = fill.dir === 'Open';

      // 添加时间过滤 - 只处理最近5分钟内的交易
      const fillTime = fill.time || Date.now();
      const currentTime = Date.now();
      const fiveMinutesAgo = currentTime - (5 * 60 * 1000); // 5分钟前

      if (fillTime < fiveMinutesAgo) {
        logger.debug(`跳过历史交易数据 - ${trader.label}`, {
          fillTime: new Date(fillTime).toISOString(),
          currentTime: new Date(currentTime).toISOString()
        });
        return;
      }

      // 检查是否是我们关注的资产
      if (this.watchedAssets && !this.watchedAssets.includes(asset)) {
        return;
      }

      if (fill.tid) {
        // 使用 trade ID
        transactionHash = fill.tid.toString();
        explorerUrl = `https://app.hyperliquid.xyz/trade/${trader.address}`;
      } else if (fill.oid) {
        // 使用 order ID
        transactionHash = fill.oid.toString();
        explorerUrl = `https://app.hyperliquid.xyz/trade/${trader.address}`;
      } else {
        // 创建基于时间和数据的哈希
        const timestamp = fill.time || Date.now();
        const dataHash = this.createDataHash(trader.address, asset, size, price, timestamp);
        transactionHash = dataHash;
        explorerUrl = `https://app.hyperliquid.xyz/trade/${trader.address}`;
      }

      // 计算名义价值
      const notionalValue = size * price;
      if (notionalValue < this.minNotionalValue) {
        return;
      }

      const event: ContractEvent = {
        timestamp: Date.now(),
        address: trader.address,
        eventType: isOpening ?
          (side === 'long' ? 'position_open_long' : 'position_open_short') :
          'position_close',
        asset,
        size: size.toString(),
        price: price.toString(),
        side,
        hash: transactionHash,
        blockTime: fill.time || Date.now(),
        metadata: {
          notionalValue: notionalValue.toString(),
          fee: fill.fee,
          startPosition: fill.startPosition,
          originalTid: fill.tid,
          explorerUrl: explorerUrl, // 添加 explorer URL
          fillData: fill
        }
      };

      this.emit('contractEvent', event, trader);
      logger.info(`合约交易事件`, {
        trader: trader.label,
        eventType: event.eventType,
        asset: event.asset,
        size: event.size,
        price: event.price,
        notionalValue: notionalValue.toFixed(2)
      });

    } catch (error) {
      logger.error(`处理交易成交失败 - ${trader.label}`, error);
    }
  }

  private processUserEvent(eventData: any, trader: ContractTrader): void {
    try {
      // 处理其他用户事件，如清算、强平等
      logger.debug(`用户事件 - ${trader.label}`, eventData);
    } catch (error) {
      logger.error(`处理用户事件失败 - ${trader.label}`, error);
    }
  }

  private processPositionUpdate(position: any, trader: ContractTrader): void {
    try {
      const asset = position.coin;
      const positionData = position.position;
      const size = parseFloat(positionData.szi || '0');
      const entryPx = parseFloat(positionData.entryPx || '0');

      // 检查是否是我们关注的资产
      if (this.watchedAssets && !this.watchedAssets.includes(asset)) {
        return;
      }

      // 计算名义价值
      const notionalValue = Math.abs(size * entryPx);
      if (notionalValue < this.minNotionalValue) {
        return;
      }

      // 记录持仓变化但不发送警报（因为这是定期快照，不是实时交易）
      logger.debug(`持仓更新 - ${trader.label}`, {
        asset,
        size: size.toString(),
        entryPrice: entryPx.toString(),
        notionalValue: notionalValue.toFixed(2)
      });

    } catch (error) {
      logger.error(`处理持仓更新失败 - ${trader.label}`, error);
    }
  }

  public createWebhookAlert(event: ContractEvent, trader: ContractTrader): ContractWebhookAlert {
    return {
      timestamp: event.timestamp,
      alertType: event.eventType as any,
      address: event.address,
      traderLabel: trader.label,
      asset: event.asset,
      size: event.size,
      price: event.price,
      side: event.side,
      txHash: event.hash,
      blockTime: event.blockTime,
      positionSizeAfter: event.positionSizeAfter,
      notionalValue: event.metadata?.notionalValue,
      leverage: event.metadata?.leverage,
    };
  }

  async stop(): Promise<void> {
    try {
      // 取消所有订阅
      for (const [key, subscription] of this.activeSubscriptions) {
        try {
          await subscription.unsubscribe();
        } catch (error) {
          logger.warn(`取消订阅失败: ${key}`, error);
        }
      }
      this.activeSubscriptions.clear();

      // 关闭传输
      if (this.transport) {
        await this.transport[Symbol.asyncDispose]();
        this.transport = null;
      }

      this.client = null;
      logger.info('合约监控器已停止');

    } catch (error) {
      logger.error('停止合约监控器失败', error);
    }
  }

  public getActiveTraders(): ContractTrader[] {
    return this.traders.filter(trader =>
      trader.isActive && this.activeSubscriptions.has(`${trader.address}_fills`)
    );
  }

  public getStats() {
    return {
      activeTraders: this.getActiveTraders().length,
      totalTraders: this.traders.length,
      activeSubscriptions: this.activeSubscriptions.size,
      minNotionalValue: this.minNotionalValue,
      watchedAssets: this.watchedAssets || '全部资产'
    };
  }

  private createDataHash(address: string, asset: string, size: number, price: number, timestamp: number): string {
    const data = `${address}_${asset}_${size}_${price}_${timestamp}`;
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    // 生成一个更像交易哈希的格式
    const hashStr = Math.abs(hash).toString(16).padStart(16, '0');
    return `HL${hashStr.toUpperCase()}`;
  }
}
