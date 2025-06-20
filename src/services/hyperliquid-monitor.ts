import * as hl from '@nktkas/hyperliquid';
import { MonitorEvent } from '../types';
import logger from '../logger';
import config from '../config';

export class HyperliquidMonitor {
  private client: hl.SubscriptionClient;
  private transport: hl.WebSocketTransport;
  private subscriptions: Map<string, any> = new Map();
  private eventCallback: (event: MonitorEvent) => Promise<void>;
  private isRunning = false;
  private reconnectAttempts = 0;

  constructor(eventCallback: (event: MonitorEvent) => Promise<void>) {
    this.eventCallback = eventCallback;

    // 初始化WebSocket传输
    this.transport = new hl.WebSocketTransport({
      url: config.hyperliquid.wsUrl,
      timeout: 10000,
      keepAlive: {
        interval: 30000,
        timeout: 10000,
      },
      reconnect: {
        maxRetries: config.hyperliquid.reconnectAttempts,
        connectionTimeout: 10000,
        connectionDelay: (attempt: number) => Math.min(1000 * Math.pow(2, attempt), 30000),
        shouldReconnect: () => this.isRunning,
      },
      autoResubscribe: true,
    });

    // 初始化订阅客户端
    this.client = new hl.SubscriptionClient({ transport: this.transport });

    logger.info('Hyperliquid监控器初始化完成', {
      wsUrl: config.hyperliquid.wsUrl,
      reconnectAttempts: config.hyperliquid.reconnectAttempts,
    });
  }

  async start(): Promise<void> {
    try {
      this.isRunning = true;

      logger.info('启动Hyperliquid监控...');

      // 等待WebSocket连接就绪
      await this.transport.ready();
      logger.info('WebSocket连接建立成功');

      // 为每个地址创建订阅
      await this.createSubscriptions();

      logger.info(`监控启动成功，正在监控 ${config.monitoring.addresses.length} 个地址`);

    } catch (error) {
      logger.error('启动监控失败:', error);
      this.isRunning = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    try {
      this.isRunning = false;

      logger.info('停止Hyperliquid监控...');

      // 取消所有订阅
      for (const [address, subscription] of this.subscriptions) {
        try {
          await subscription.unsubscribe();
          logger.debug(`取消订阅: ${address}`);
        } catch (error) {
          logger.warn(`取消订阅失败 ${address}:`, error);
        }
      }
      this.subscriptions.clear();

      // 关闭WebSocket连接
      await this.transport.close();

      logger.info('监控已停止');

    } catch (error) {
      logger.error('停止监控失败:', error);
    }
  }

  private async createSubscriptions(): Promise<void> {
    const addresses = config.monitoring.addresses.filter(addr => addr.isActive);

    for (const addressInfo of addresses) {
      try {
        await this.subscribeToAddress(addressInfo.address, addressInfo.label);
      } catch (error) {
        logger.error(`为地址 ${addressInfo.label} 创建订阅失败:`, error);
      }
    }
  }

  private async subscribeToAddress(address: string, label: string): Promise<void> {
    try {
      // 订阅用户事件（包含转账等信息）
      const userEventsSub = await this.client.userEvents(
        { user: address as `0x${string}` },
        (data) => this.handleUserEvents(data, address, label)
      );

      // 订阅用户非资金费用账本更新（包含转账详情）
      const ledgerUpdatesSub = await this.client.userNonFundingLedgerUpdates(
        { user: address as `0x${string}` },
        (data) => this.handleLedgerUpdates(data, address, label)
      );

      // 订阅用户成交（用于监控HYPE现货买入）
      const userFillsSub = await this.client.userFills(
        { user: address as `0x${string}` },
        (data) => this.handleUserFills(data, address, label)
      );

      // 保存订阅引用
      this.subscriptions.set(`${address}_events`, userEventsSub);
      this.subscriptions.set(`${address}_ledger`, ledgerUpdatesSub);
      this.subscriptions.set(`${address}_fills`, userFillsSub);

      logger.info(`订阅创建成功: ${label} (${address})`);

    } catch (error) {
      logger.error(`创建订阅失败 ${label}:`, error);
      throw error;
    }
  }

  private async handleUserEvents(data: any, address: string, label: string): Promise<void> {
    try {
      logger.debug(`收到用户事件: ${label}`, { data });

      // 这里需要解析data结构来提取转账信息
      // 具体实现需要根据实际的WebSocket数据格式
      if (this.isHypeTransferEvent(data)) {
        const event = this.parseTransferEvent(data, address);
        if (event) {
          await this.eventCallback(event);
        }
      }

    } catch (error) {
      logger.error(`处理用户事件失败 ${label}:`, error);
    }
  }

  private async handleLedgerUpdates(data: any, address: string, label: string): Promise<void> {
    try {
      logger.debug(`收到账本更新: ${label}`, { data });

      // 解析账本更新中的HYPE转账信息
      if (this.isHypeLedgerUpdate(data)) {
        const event = this.parseLedgerUpdate(data, address);
        if (event) {
          await this.eventCallback(event);
        }
      }

    } catch (error) {
      logger.error(`处理账本更新失败 ${label}:`, error);
    }
  }

  private async handleUserFills(data: any, address: string, label: string): Promise<void> {
    try {
      logger.debug(`收到用户成交: ${label}`, { data });

      // 检查是否是HYPE现货买入
      if (this.isHypeSpotBuy(data)) {
        const event = this.parseSpotBuyEvent(data, address);
        if (event) {
          await this.eventCallback(event);
        }
      }

    } catch (error) {
      logger.error(`处理用户成交失败 ${label}:`, error);
    }
  }

  private isHypeTransferEvent(data: any): boolean {
    // 实现HYPE转账事件检测逻辑
    // 需要根据实际WebSocket数据格式来实现
    return false; // 临时返回false，需要实际数据结构来完善
  }

  private isHypeLedgerUpdate(data: any): boolean {
    // 实现HYPE账本更新检测逻辑
    return false; // 临时返回false，需要实际数据结构来完善
  }

  private isHypeSpotBuy(data: any): boolean {
    // 检查是否是HYPE现货买入（@107资产）
    return false; // 临时返回false，需要实际数据结构来完善
  }

  private parseTransferEvent(data: any, address: string): MonitorEvent | null {
    // 解析转账事件数据
    return null; // 需要实际数据结构来实现
  }

  private parseLedgerUpdate(data: any, address: string): MonitorEvent | null {
    // 解析账本更新数据
    return null; // 需要实际数据结构来实现
  }

  private parseSpotBuyEvent(data: any, address: string): MonitorEvent | null {
    // 解析现货买入事件数据
    return null; // 需要实际数据结构来实现
  }

  // 获取监控状态
  getStatus(): {
    isRunning: boolean;
    subscriptionsCount: number;
    reconnectAttempts: number;
  } {
    return {
      isRunning: this.isRunning,
      subscriptionsCount: this.subscriptions.size,
      reconnectAttempts: this.reconnectAttempts,
    };
  }
}

export default HyperliquidMonitor;
