import { MonitorEvent, WatchedAddress } from '../types';
import HyperliquidDataParser from '../utils/data-parser';
import logger from '../logger';
import config from '../config';
import { EventEmitter } from 'events';
import * as hl from '@nktkas/hyperliquid';
import WebSocket from 'ws';

// Node.js WebSocket polyfill
if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = WebSocket as any;
}

// 单个批次监控器
class BatchMonitor {
  private client: hl.SubscriptionClient;
  private transport: hl.WebSocketTransport;
  private subscriptions: Map<string, any> = new Map();
  private addresses: WatchedAddress[];
  private eventCallback: (event: MonitorEvent) => Promise<void>;
  private isRunning = false;
  private batchId: number;

  constructor(
    addresses: WatchedAddress[],
    eventCallback: (event: MonitorEvent) => Promise<void>,
    batchId: number
  ) {
    this.addresses = addresses;
    this.eventCallback = eventCallback;
    this.batchId = batchId;

    // 为每个批次创建独立的WebSocket连接
    this.transport = new hl.WebSocketTransport({
      url: config.hyperliquid.wsUrl,
      timeout: 30000, // 增加到30秒
      keepAlive: {
        interval: 20000, // 20秒心跳
        timeout: 15000,
      },
      reconnect: {
        maxRetries: 20, // 增加重试次数
        connectionTimeout: 30000, // 增加连接超时
        connectionDelay: (attempt: number) => {
          // 更温和的退避策略，最大延迟30秒
          return Math.min(1000 * Math.pow(1.2, attempt), 30000);
        },
        shouldReconnect: (error: any) => {
          logger.debug(`批次${this.batchId} WebSocket重连判断`, { error: error?.message });
          return true; // 总是尝试重连
        },
      },
    });

    this.client = new hl.SubscriptionClient({
      transport: this.transport,
    });
  }

  async start(): Promise<void> {
    try {
      logger.info(`启动批次${this.batchId}监控器...`, {
        batchId: this.batchId,
        addressCount: this.addresses.length,
        addresses: this.addresses.map(addr => addr.label)
      });

      // 等待WebSocket连接建立
      await this.waitForConnection();

      // 为这批地址创建所有必要的订阅
      await this.subscribeToAddresses();

      this.isRunning = true;
      logger.info(`批次${this.batchId}监控器启动成功`, {
        batchId: this.batchId,
        subscriptionsCount: this.subscriptions.size
      });

    } catch (error) {
      logger.error(`批次${this.batchId}监控器启动失败:`, error);
      throw error;
    }
  }

  private async waitForConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`批次${this.batchId} WebSocket连接超时`));
      }, 10000);

      // 优化：减少等待时间，尽快开始订阅
      setTimeout(() => {
        clearTimeout(timeout);
        logger.debug(`批次${this.batchId} WebSocket连接建立成功`);
        resolve();
      }, 200); // 从1秒减少到200毫秒
    });
  }

  private async subscribeToAddresses(): Promise<void> {
    const subscriptionPromises: Promise<void>[] = [];

    for (const addressInfo of this.addresses) {
      if (!addressInfo.isActive) {
        logger.debug(`跳过未激活地址: ${addressInfo.label}`);
        continue;
      }

      // 为每个地址创建三种订阅
      subscriptionPromises.push(
        this.subscribeToUserEvents(addressInfo),
        this.subscribeToUserFills(addressInfo),
        this.subscribeToLedgerUpdates(addressInfo)
      );
    }

    await Promise.all(subscriptionPromises);
  }

  private async subscribeToUserEvents(addressInfo: WatchedAddress): Promise<void> {
    const maxRetries = 3;
    let attempt = 0;
    
    while (attempt < maxRetries) {
      try {
        const subscription = await this.client.userEvents(
          { user: addressInfo.address as `0x${string}` },
          (data: any) => this.handleUserEvents(data, addressInfo.address, addressInfo.label)
        );

        this.subscriptions.set(`userEvents:${addressInfo.address}`, subscription);
        logger.debug(`批次${this.batchId} 用户事件订阅成功: ${addressInfo.label}`);
        return; // 成功则退出
        
      } catch (error) {
        attempt++;
        logger.warn(`批次${this.batchId} 用户事件订阅失败 ${addressInfo.label} (尝试 ${attempt}/${maxRetries}):`, error);
        
        if (attempt < maxRetries) {
          // 等待后重试
          await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
      }
    }
    
    logger.error(`批次${this.batchId} 用户事件订阅最终失败: ${addressInfo.label}`);
  }

  private async subscribeToUserFills(addressInfo: WatchedAddress): Promise<void> {
    const maxRetries = 3;
    let attempt = 0;
    
    while (attempt < maxRetries) {
      try {
        const subscription = await this.client.userFills(
          { user: addressInfo.address as `0x${string}` },
          (data: any) => this.handleUserFills(data, addressInfo.address, addressInfo.label)
        );

        this.subscriptions.set(`userFills:${addressInfo.address}`, subscription);
        logger.debug(`批次${this.batchId} 用户成交订阅成功: ${addressInfo.label}`);
        return;
        
      } catch (error) {
        attempt++;
        logger.warn(`批次${this.batchId} 用户成交订阅失败 ${addressInfo.label} (尝试 ${attempt}/${maxRetries}):`, error);
        
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
      }
    }
    
    logger.error(`批次${this.batchId} 用户成交订阅最终失败: ${addressInfo.label}`);
  }

  private async subscribeToLedgerUpdates(addressInfo: WatchedAddress): Promise<void> {
    const maxRetries = 3;
    let attempt = 0;
    
    while (attempt < maxRetries) {
      try {
        const subscription = await this.client.userNonFundingLedgerUpdates(
          { user: addressInfo.address as `0x${string}` },
          (data: any) => this.handleLedgerUpdates(data, addressInfo.address, addressInfo.label)
        );

        this.subscriptions.set(`ledger:${addressInfo.address}`, subscription);
        logger.debug(`批次${this.batchId} 账本更新订阅成功: ${addressInfo.label}`);
        return;
        
      } catch (error) {
        attempt++;
        logger.warn(`批次${this.batchId} 账本更新订阅失败 ${addressInfo.label} (尝试 ${attempt}/${maxRetries}):`, error);
        
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
      }
    }
    
    logger.error(`批次${this.batchId} 账本更新订阅最终失败: ${addressInfo.label}`);
  }

  private async handleUserEvents(data: any, address: string, label: string): Promise<void> {
    try {
      // 过滤掉funding事件和订单相关事件
      if (data && Object.keys(data).includes('funding')) {
        logger.debug(`批次${this.batchId} 跳过funding事件: ${label}`);
        return;
      }

      // 检查是否是订单相关事件（modify, cancel等）
      const dataKeys = Object.keys(data || {});
      const orderRelatedKeys = ['modify', 'batchModify', 'cancel', 'batchCancel', 'order'];
      if (dataKeys.some(key => orderRelatedKeys.some(orderKey => key.toLowerCase().includes(orderKey.toLowerCase())))) {
        logger.debug(`批次${this.batchId} 跳过订单相关事件: ${label}`, {
          eventKeys: dataKeys
        });
        return;
      }

      // 🔥 新增：过滤快照数据，只处理实时事件
      if (data && data.isSnapshot === true) {
        logger.debug(`批次${this.batchId} 跳过快照数据: ${label}`, {
          isSnapshot: data.isSnapshot,
          fillCount: data.fills?.length || 0
        });
        return;
      }

      logger.debug(`批次${this.batchId} 收到用户事件: ${label}`, {
        dataKeys: Object.keys(data),
        isSnapshot: data.isSnapshot,
        fillCount: data.fills?.length || 0
      });

      // 使用数据解析器处理用户事件数据
      const events = HyperliquidDataParser.parseUserEvents(data, address);
      const hypeEvents = HyperliquidDataParser.filterHypeEvents(events);

      for (const event of hypeEvents) {
        if (HyperliquidDataParser.shouldMonitorEvent(event)) {
          const summary = HyperliquidDataParser.createEventSummary(event);
          logger.info(`批次${this.batchId} 检测到HYPE交易: ${label} - ${summary}`, {
            fullTxHash: event.hash,
            shortTxHash: event.hash.substring(0, 10) + '...',
            amount: event.amount,
            type: event.eventType,
            address: event.address,
            blockTime: new Date(event.blockTime).toISOString(),
            isHistorical: event.blockTime < Date.now() - 60000 // 1分钟前的认为是历史数据
          });

          await this.eventCallback(event);
        }
      }

    } catch (error) {
      logger.error(`批次${this.batchId} 处理用户事件失败 ${label}:`, error);
    }
  }

  private async handleLedgerUpdates(data: any, address: string, label: string): Promise<void> {
    try {
      // 🔥 新增：过滤快照数据
      if (data && data.isSnapshot === true) {
        logger.debug(`批次${this.batchId} 跳过账本快照数据: ${label}`, {
          isSnapshot: data.isSnapshot,
          updateCount: data.nonFundingLedgerUpdates?.length || 0
        });
        return;
      }

      logger.debug(`批次${this.batchId} 收到账本更新: ${label}`, {
        updateCount: data.nonFundingLedgerUpdates?.length || 0,
        isSnapshot: data.isSnapshot
      });

      // 使用数据解析器处理账本更新数据
      const events = HyperliquidDataParser.parseUserNonFundingLedgerUpdates(data, address);
      const hypeEvents = HyperliquidDataParser.filterHypeEvents(events);

      for (const event of hypeEvents) {
        if (HyperliquidDataParser.shouldMonitorEvent(event)) {
          const summary = HyperliquidDataParser.createEventSummary(event);
          logger.info(`批次${this.batchId} 检测到HYPE转账: ${label} - ${summary}`, {
            fullTxHash: event.hash,
            shortTxHash: event.hash.substring(0, 10) + '...',
            amount: event.amount,
            type: event.eventType,
            address: event.address,
            counterparty: event.metadata?.counterparty,
            blockTime: new Date(event.blockTime).toISOString(),
            isHistorical: event.blockTime < Date.now() - 60000 // 1分钟前的认为是历史数据
          });

          await this.eventCallback(event);
        }
      }

    } catch (error) {
      logger.error(`批次${this.batchId} 处理账本更新失败 ${label}:`, error);
    }
  }

  private async handleUserFills(data: any, address: string, label: string): Promise<void> {
    try {
      // 🔥 新增：过滤快照数据
      if (data && data.isSnapshot === true) {
        logger.debug(`批次${this.batchId} 跳过成交快照数据: ${label}`, {
          isSnapshot: data.isSnapshot,
          fillCount: data.fills?.length || 0
        });
        return;
      }

      logger.debug(`批次${this.batchId} 收到用户成交: ${label}`, {
        fillCount: data.fills?.length || 0,
        isSnapshot: data.isSnapshot
      });

      // 使用数据解析器处理用户成交数据
      const events = HyperliquidDataParser.parseUserEvents(data, address);
      const hypeEvents = HyperliquidDataParser.filterHypeEvents(events);

      for (const event of hypeEvents) {
        if (HyperliquidDataParser.shouldMonitorEvent(event)) {
          const summary = HyperliquidDataParser.createEventSummary(event);
          logger.info(`批次${this.batchId} 检测到HYPE成交: ${label} - ${summary}`, {
            fullTxHash: event.hash,
            shortTxHash: event.hash.substring(0, 10) + '...',
            amount: event.amount,
            type: event.eventType,
            address: event.address,
            price: event.metadata?.price,
            blockTime: new Date(event.blockTime).toISOString(),
            isHistorical: event.blockTime < Date.now() - 60000 // 1分钟前的认为是历史数据
          });

          await this.eventCallback(event);
        }
      }

    } catch (error) {
      logger.error(`批次${this.batchId} 处理用户成交失败 ${label}:`, error);
    }
  }

  async stop(): Promise<void> {
    try {
      logger.info(`停止批次${this.batchId}监控器...`);

      // 取消所有订阅
      for (const [key, subscription] of this.subscriptions) {
        try {
          await subscription.unsubscribe();
          logger.debug(`批次${this.batchId} 取消订阅: ${key}`);
        } catch (error) {
          logger.warn(`批次${this.batchId} 取消订阅失败 ${key}:`, error);
        }
      }

      this.subscriptions.clear();
      this.isRunning = false;

      logger.info(`批次${this.batchId}监控器已停止`);
    } catch (error) {
      logger.error(`批次${this.batchId} 停止监控器失败:`, error);
    }
  }

  getStatus(): {
    batchId: number;
    isRunning: boolean;
    subscriptionsCount: number;
    addressCount: number;
  } {
    return {
      batchId: this.batchId,
      isRunning: this.isRunning,
      subscriptionsCount: this.subscriptions.size,
      addressCount: this.addresses.length,
    };
  }
}

// 批量监控管理器
export class BatchedHyperliquidMonitor {
  private batchMonitors: BatchMonitor[] = [];
  private eventCallback: (event: MonitorEvent) => Promise<void>;
  private isRunning = false;
  private static readonly BATCH_SIZE = 13; // 增加批次大小，减少批次数量

  constructor(eventCallback: (event: MonitorEvent) => Promise<void>) {
    this.eventCallback = eventCallback;

    // 增加事件监听器限制
    EventEmitter.defaultMaxListeners = 100;
  }

  async start(): Promise<void> {
    try {
      logger.info('启动批量HYPE监控系统...', {
        totalAddresses: config.monitoring.addresses.length,
        batchSize: BatchedHyperliquidMonitor.BATCH_SIZE
      });

      // 将26个地址分成多个批次
      const addressBatches = this.createAddressBatches();

      logger.info(`创建${addressBatches.length}个监控批次`, {
        batches: addressBatches.map((batch, index) => ({
          batchId: index + 1,
          addressCount: batch.length,
          addresses: batch.map(addr => addr.label)
        }))
      });

      // 为每个批次创建监控器
      this.batchMonitors = addressBatches.map((addresses, index) =>
        new BatchMonitor(addresses, this.eventCallback, index + 1)
      );

      // 启动所有批次监控器
      const startPromises = this.batchMonitors.map(monitor => monitor.start());
      await Promise.all(startPromises);

      this.isRunning = true;

      logger.info('批量HYPE监控系统启动成功', {
        totalBatches: this.batchMonitors.length,
        totalSubscriptions: this.getTotalSubscriptions(),
        status: this.getStatus()
      });

    } catch (error) {
      logger.error('批量监控系统启动失败:', error);
      await this.stop();
      throw error;
    }
  }

  private createAddressBatches(): WatchedAddress[][] {
    const activeAddresses = config.monitoring.addresses.filter(addr => addr.isActive);
    const batches: WatchedAddress[][] = [];
    const batchSize = BatchedHyperliquidMonitor.BATCH_SIZE;

    for (let i = 0; i < activeAddresses.length; i += batchSize) {
      const batch = activeAddresses.slice(i, i + batchSize);
      batches.push(batch);
    }

    return batches;
  }

  async stop(): Promise<void> {
    try {
      logger.info('停止批量HYPE监控系统...');

      // 停止所有批次监控器
      const stopPromises = this.batchMonitors.map(monitor => monitor.stop());
      await Promise.all(stopPromises);

      this.batchMonitors = [];
      this.isRunning = false;

      logger.info('批量HYPE监控系统已停止');
    } catch (error) {
      logger.error('停止批量监控系统失败:', error);
    }
  }

  private getTotalSubscriptions(): number {
    return this.batchMonitors.reduce((total, monitor) => {
      return total + monitor.getStatus().subscriptionsCount;
    }, 0);
  }

  getStatus(): {
    isRunning: boolean;
    totalBatches: number;
    totalSubscriptions: number;
    batchStatuses: Array<{
      batchId: number;
      isRunning: boolean;
      subscriptionsCount: number;
      addressCount: number;
    }>;
  } {
    return {
      isRunning: this.isRunning,
      totalBatches: this.batchMonitors.length,
      totalSubscriptions: this.getTotalSubscriptions(),
      batchStatuses: this.batchMonitors.map(monitor => monitor.getStatus()),
    };
  }
}

// 兼容性导出
export { BatchedHyperliquidMonitor as HyperliquidMonitor };
export default BatchedHyperliquidMonitor;