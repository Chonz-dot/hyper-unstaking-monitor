import { EventEmitter } from 'events';
import { ContractTrader, ContractEvent, ContractWebhookAlert } from '../types';
import logger from '../logger';
import config from '../config';
import * as hl from '@nktkas/hyperliquid';
import WebSocket from 'ws';

// Node.js WebSocket polyfill
if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = WebSocket as any;
}

/**
 * 基于WebSocket的合约监控器 - 优化的多实例架构
 * 每个交易员独立WebSocket连接，优化订阅策略
 */
export class WebSocketContractMonitor extends EventEmitter {
  private traders: ContractTrader[];
  private minNotionalValue: number;
  private traderClients = new Map<string, { transport: hl.WebSocketTransport, client: hl.SubscriptionClient, subscription?: any }>();
  private isRunning = false;
  private startTime: number;
  private consecutiveErrors = 0;
  private maxConsecutiveErrors: number;
  private reconnectAttempts = new Map<string, number>(); // 记录每个交易员的重连尝试次数
  private maxReconnectAttempts: number;
  private connectionHealth = new Map<string, {
    lastPingTime: number;
    consecutiveFailures: number;
    totalReconnects: number;
    lastSuccessfulMessage: number;
  }>(); // 连接健康状态跟踪
  
  // 订单聚合管理 - 与连接池版本保持一致
  private pendingOrderFills = new Map<string, {
    oid: number;
    trader: ContractTrader;
    fills: any[];
    totalSize: number;
    avgPrice: number;
    firstFill: any;
    lastUpdate: number;
  }>();
  private readonly ORDER_COMPLETION_DELAY = 3000;

  constructor(traders: ContractTrader[], minNotionalValue = 10) {
    super();
    this.traders = traders.filter(t => t.isActive);
    this.minNotionalValue = minNotionalValue;
    this.startTime = Date.now();
    this.maxConsecutiveErrors = config.hyperliquid.maxConsecutiveErrors;
    this.maxReconnectAttempts = config.hyperliquid.maxReconnectAttempts;
    
    logger.info('🔄 初始化优化多实例WebSocket合约监控器', {
      activeTraders: this.traders.length,
      minNotionalValue,
      startTime: new Date(this.startTime).toISOString(),
      architecture: '每个交易员独立WebSocket连接 - 优化版'
    });
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('WebSocket合约监控器已在运行');
      return;
    }

    logger.info('🚀 启动优化多实例WebSocket合约监控器');
    this.isRunning = true;
    this.consecutiveErrors = 0;
    
    try {
      await this.createOptimizedConnections();
      
      logger.info('✅ 优化多实例WebSocket合约监控器启动成功', {
        activeTraders: this.traders.length,
        connections: this.traderClients.size,
        successRate: `${Math.round((this.traderClients.size / this.traders.length) * 100)}%`
      });
      
      this.startStatusMonitoring();
      
    } catch (error) {
      logger.error('WebSocket合约监控器启动失败:', error);
      this.isRunning = false;
      throw error;
    }
  }

  private async createOptimizedConnections(): Promise<void> {
    logger.info('🔗 创建优化的独立WebSocket连接...');
    
    for (let i = 0; i < this.traders.length; i++) {
      const trader = this.traders[i];
      
      try {
        logger.info(`🔗 处理 ${i + 1}/${this.traders.length}: ${trader.label}`);
        
        // 每个交易员之间增加更长的延迟，避免API限制
        if (i > 0) {
          // 基础延迟 + 随机延迟0-10秒，避免同步冲突
          const baseDelay = config.hyperliquid.connectionDelay;
          const randomDelay = Math.floor(Math.random() * 10000);
          const totalDelay = baseDelay + randomDelay;
          logger.info(`⏳ 等待${totalDelay/1000}秒后处理${trader.label}... (基础${baseDelay/1000}秒 + 随机${randomDelay/1000}秒)`);
          await new Promise(resolve => setTimeout(resolve, totalDelay));
        }
        
        await this.createSingleConnection(trader, i + 1);
        
      } catch (error) {
        logger.error(`❌ ${trader.label} 处理失败:`, {
          error: error instanceof Error ? error.message : String(error),
          position: `${i + 1}/${this.traders.length}`,
          willContinue: true
        });
        this.consecutiveErrors++;
        
        // 记录失败但继续处理其他交易员
        logger.info(`🔄 ${trader.label} 连接失败，但继续处理其他交易员...`);
      }
    }
    
    logger.info('📊 优化连接创建完成', {
      totalTraders: this.traders.length,
      successfulConnections: this.traderClients.size,
      failedConnections: this.traders.length - this.traderClients.size,
      successRate: `${Math.round((this.traderClients.size / this.traders.length) * 100)}%`,
      consecutiveErrors: this.consecutiveErrors
    });
    
    // 优雅降级：只要有一个连接成功就继续运行
    if (this.traderClients.size === 0) {
      throw new Error('所有交易员连接都失败了');
    } else if (this.traderClients.size < this.traders.length) {
      logger.warn(`⚠️ 部分交易员连接失败，但继续运行。成功连接：${this.traderClients.size}/${this.traders.length}`);
    }
  }

  private async createSingleConnection(trader: ContractTrader, position: number): Promise<void> {
    logger.info(`🔧 为${trader.label}创建独立连接 (${position}/${this.traders.length})`);
    
    // 创建独立的WebSocket传输
    const transport = new hl.WebSocketTransport({
      url: config.hyperliquid.wsUrl,
      timeout: config.hyperliquid.connectionTimeout,
      keepAlive: { 
        interval: 25000,  // 25秒心跳间隔，更保守
        timeout: 15000    // 15秒心跳超时
      },
      reconnect: {
        maxRetries: 20,   // 增加重试次数
        connectionTimeout: config.hyperliquid.connectionTimeout,
        connectionDelay: (attempt: number) => {
          // 更渐进的退避策略：2s, 4s, 8s, 16s, 30s(最大)
          return Math.min(2000 * Math.pow(2, attempt - 1), 30000);
        },
        shouldReconnect: (error: any) => {
          // 更智能的重连判断
          if (this.consecutiveErrors > this.maxConsecutiveErrors) {
            logger.error(`${trader.label} 连续错误过多，停止重连`, { consecutiveErrors: this.consecutiveErrors });
            return false;
          }
          
          // 检查特定错误类型，某些错误不应重连
          const errorMessage = error?.message?.toLowerCase() || '';
          if (errorMessage.includes('unauthorized') || errorMessage.includes('forbidden')) {
            logger.error(`${trader.label} 认证错误，停止重连`, { error: errorMessage });
            return false;
          }
          
          logger.debug(`${trader.label} 将尝试重连`, { error: errorMessage, consecutiveErrors: this.consecutiveErrors });
          return true;
        }
      },
      autoResubscribe: true, // 启用自动重订阅！
    });

    // 创建独立的客户端
    const client = new hl.SubscriptionClient({ transport });
    
    // 保存到映射中并初始化健康状态
    this.traderClients.set(trader.address, { transport, client });
    this.connectionHealth.set(trader.address, {
      lastPingTime: Date.now(),
      consecutiveFailures: 0,
      totalReconnects: 0,
      lastSuccessfulMessage: Date.now()
    });
    
    // 监听连接状态变化和错误
    transport.ready()
      .then(() => {
        // 连接成功时重置健康状态
        const health = this.connectionHealth.get(trader.address);
        if (health) {
          health.consecutiveFailures = 0;
          health.lastPingTime = Date.now();
          this.connectionHealth.set(trader.address, health);
        }
        
        // 重置重连计数
        const currentAttempts = this.reconnectAttempts.get(trader.address) || 0;
        if (currentAttempts > 0) {
          this.reconnectAttempts.set(trader.address, 0);
          logger.info(`✅ ${trader.label} 连接恢复，重置重连计数`);
        }
      })
      .catch((error) => {
        // 连接失败时更新健康状态
        const health = this.connectionHealth.get(trader.address);
        if (health) {
          health.consecutiveFailures++;
          this.connectionHealth.set(trader.address, health);
        }
        
        logger.error(`❌ ${trader.label} 连接监听错误:`, error);
        this.consecutiveErrors++;
      });
    
    try {
      // 等待连接就绪
      logger.info(`🔗 ${trader.label} 等待连接建立...`);
      await this.waitForConnectionWithTimeout(transport, trader.label, config.hyperliquid.connectionTimeout);
      
      // 订阅用户事件
      logger.info(`📡 ${trader.label} 开始订阅用户事件...`);
      await this.subscribeWithRetry(trader, client);
      
      logger.info(`✅ ${trader.label} 连接和订阅完全成功`);
      
    } catch (error) {
      logger.error(`💥 ${trader.label} 连接或订阅失败:`, error);
      
      // 清理失败的连接
      try {
        await transport.close();
      } catch (closeError) {
        logger.debug(`清理${trader.label}连接时出错:`, closeError);
      }
      
      this.traderClients.delete(trader.address);
      throw error;
    }
  }

  private async waitForConnectionWithTimeout(transport: hl.WebSocketTransport, traderLabel: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`${traderLabel}连接超时 (${timeoutMs/1000}秒)`));
      }, timeoutMs);
      
      transport.ready()
        .then(() => {
          clearTimeout(timeout);
          logger.info(`✅ ${traderLabel}连接就绪`);
          resolve();
        })
        .catch((error) => {
          clearTimeout(timeout);
          logger.error(`❌ ${traderLabel}连接失败:`, error);
          reject(error);
        });
    });
  }

  private async subscribeWithRetry(trader: ContractTrader, client: hl.SubscriptionClient, maxRetries = 3): Promise<void> {
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.info(`📡 ${trader.label} 订阅尝试 ${attempt}/${maxRetries}`);
        
        const subscription = await this.performSubscription(trader, client);
        
        // 保存订阅引用
        const clientData = this.traderClients.get(trader.address);
        if (clientData) {
          clientData.subscription = subscription;
        }
        
        logger.info(`🎯 ${trader.label} 订阅成功 (尝试 ${attempt})`);
        return; // 成功，退出重试循环
        
      } catch (error) {
        lastError = error as Error;
        logger.warn(`⚠️ ${trader.label} 订阅尝试 ${attempt} 失败:`, {
          error: lastError.message,
          willRetry: attempt < maxRetries
        });
        
        if (attempt < maxRetries) {
          // 指数退避重试延迟：5秒 * 尝试次数
          const retryDelay = 5000 * attempt;
          logger.info(`⏳ ${trader.label} ${retryDelay/1000}秒后重试...`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
    }
    
    // 所有重试都失败
    throw new Error(`${trader.label}所有订阅尝试都失败: ${lastError?.message}`);
  }

  private async performSubscription(trader: ContractTrader, client: hl.SubscriptionClient): Promise<any> {
    return new Promise((resolve, reject) => {
      // 使用配置的订阅超时时间
      const timeout = setTimeout(() => {
        reject(new Error(`${trader.label}订阅超时 (${config.hyperliquid.subscriptionTimeout/1000}秒)`));
      }, config.hyperliquid.subscriptionTimeout);
      
      logger.debug(`🔗 ${trader.label} 调用client.userEvents...`);
      
      client.userEvents(
        { user: trader.address as `0x${string}` },
        (data: any) => {
          this.handleUserEvent(data, trader);
        }
      ).then((subscription) => {
        clearTimeout(timeout);
        logger.debug(`📋 ${trader.label} userEvents Promise resolved`);
        resolve(subscription);
        
      }).catch((error) => {
        clearTimeout(timeout);
        logger.error(`💥 ${trader.label} userEvents Promise rejected:`, {
          error: error instanceof Error ? error.message : String(error),
          errorType: error?.constructor?.name
        });
        reject(error);
      });
    });
  }

  private handleUserEvent(data: any, trader: ContractTrader): void {
    try {
      // 更新连接健康状态 - 收到消息说明连接活跃
      const health = this.connectionHealth.get(trader.address);
      if (health) {
        health.lastSuccessfulMessage = Date.now();
        health.consecutiveFailures = 0; // 重置失败计数
        this.connectionHealth.set(trader.address, health);
      }
      
      logger.debug(`📨 收到${trader.label}事件`, {
        eventKeys: Object.keys(data || {}),
        timestamp: new Date().toISOString()
      });

      // 处理合约持仓变化事件
      if (data.delta && data.delta.type === 'perpetualPosition') {
        this.processDeltaEvent(data, trader);
        return;
      }

      // 处理交易成交事件（包括合约交易）
      if (data.fills && Array.isArray(data.fills)) {
        this.processFillsEvent(data, trader);
        return;
      }
      
      // 其他事件类型的调试信息
      logger.debug(`📋 ${trader.label} 收到其他类型事件:`, {
        hasUserEvents: !!data.userEvents,
        hasLedgerUpdates: !!data.ledgerUpdates,
        hasActiveAssetData: !!data.activeAssetData,
        dataKeys: Object.keys(data || {})
      });
      
    } catch (error) {
      logger.error(`处理${trader.label}事件失败:`, error);
      this.consecutiveErrors++;
      
      // 更新连接健康状态
      const health = this.connectionHealth.get(trader.address);
      if (health) {
        health.consecutiveFailures++;
        this.connectionHealth.set(trader.address, health);
      }
    }
  }

  private processDeltaEvent(data: any, trader: ContractTrader): void {
    const signal = this.convertToContractSignal(data, trader);
    if (signal) {
      this.emit('contractEvent', signal, trader);
    }
  }

  private processFillsEvent(data: any, trader: ContractTrader): void {
    if (!data.fills || !Array.isArray(data.fills)) {
      return;
    }

    for (const fill of data.fills) {
      const signal = this.convertFillToContractSignal(fill, trader);
      if (signal) {
        logger.debug(`🎯 ${trader.label} 处理合约交易:`, {
          asset: signal.asset,
          size: signal.size,
          side: signal.side,
          eventType: signal.eventType
        });
        this.emit('contractEvent', signal, trader);
      }
    }
  }

  private convertFillToContractSignal(fill: any, trader: ContractTrader): ContractEvent | null {
    try {
      // 检查是否为合约交易（非现货）
      const coin = fill.coin;
      if (!coin || typeof coin !== 'string') {
        return null;
      }

      // 现货资产以@开头，跳过现货交易
      if (coin.startsWith('@')) {
        logger.debug(`⏭️ ${trader.label} 跳过现货交易: ${coin}`);
        return null;
      }

      const size = parseFloat(fill.sz || '0');
      const price = parseFloat(fill.px || '0');
      const side = fill.side === 'B' ? 'long' : 'short'; // B=买入/多, A=卖出/空
      const notionalValue = Math.abs(size) * price;

      // 检查是否满足最小名义价值
      if (notionalValue < this.minNotionalValue) {
        logger.debug(`⏭️ ${trader.label} 交易金额过小: ${notionalValue} < ${this.minNotionalValue}`);
        return null;
      }

      // 确定事件类型
      let eventType: 'position_open_long' | 'position_open_short' | 'position_close' | 'position_increase' | 'position_decrease';
      if (side === 'long') {
        eventType = 'position_open_long';
      } else {
        eventType = 'position_open_short';
      }

      // 时间戳处理
      let blockTime: number;
      if (fill.time) {
        blockTime = fill.time > 1e12 ? Math.floor(fill.time / 1000) : Math.floor(fill.time);
      } else {
        blockTime = Math.floor(Date.now() / 1000);
      }

      const result: ContractEvent = {
        timestamp: Date.now(),
        address: trader.address,
        eventType,
        asset: coin,
        size: Math.abs(size).toString(),
        price: price.toString(),
        side,
        hash: fill.hash || fill.tid || `fill_${Date.now()}_${coin}`,
        blockTime: blockTime,
        metadata: {
          notionalValue: notionalValue.toString(),
          originalAsset: coin,
          source: 'websocket-fills',
          isRealTime: true,
          fillType: fill.side,
          originalFill: fill
        }
      };

      return result;
      
    } catch (error) {
      logger.error(`转换Fill事件失败 (${trader.label}):`, error);
      return null;
    }
  }

  private convertToContractSignal(event: any, trader: ContractTrader): ContractEvent | null {
    try {
      if (!event.delta || event.delta.type !== 'perpetualPosition') {
        return null;
      }

      const positionData = event.delta.perpetualPosition;
      if (!positionData || !positionData.position) {
        return null;
      }

      const coin = positionData.coin;
      const currentSize = parseFloat(positionData.position.szi || '0');
      const markPrice = parseFloat(positionData.markPrice || '0');
      
      // 跳过现货资产
      if (coin.startsWith('@')) {
        return null;
      }

      const notionalValue = Math.abs(currentSize) * markPrice;
      if (notionalValue < this.minNotionalValue) {
        return null;
      }

      // 简化的事件类型判断
      let eventType: 'position_open_long' | 'position_open_short' | 'position_close';
      let side: 'long' | 'short';
      
      if (Math.abs(currentSize) < 0.0001) {
        eventType = 'position_close';
        side = 'long'; // 默认值
      } else if (currentSize > 0) {
        eventType = 'position_open_long';
        side = 'long';
      } else {
        eventType = 'position_open_short';
        side = 'short';
      }

      // 时间戳处理
      let blockTime: number;
      if (event.time) {
        blockTime = event.time > 1e12 ? Math.floor(event.time / 1000) : Math.floor(event.time);
      } else {
        blockTime = Math.floor(Date.now() / 1000);
      }

      const result: ContractEvent = {
        timestamp: Date.now(),
        address: trader.address,
        eventType,
        asset: coin,
        size: Math.abs(currentSize).toString(),
        price: markPrice.toString(),
        side,
        hash: event.hash || `pos_${Date.now()}_${coin}`,
        blockTime: blockTime,
        positionSizeAfter: currentSize.toString(),
        metadata: {
          notionalValue: notionalValue.toString(),
          originalAsset: coin,
          source: 'websocket-perpetualPosition',
          isRealTime: true,
          markPrice: markPrice.toString(),
          rawEventTime: event.time
        }
      };

      return result;
      
    } catch (error) {
      logger.error('转换合约信号失败:', error);
      return null;
    }
  }

  createWebhookAlert(event: ContractEvent, trader: ContractTrader): ContractWebhookAlert {
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
      mergedCount: 1,
      originalFillsCount: 1,
      isMerged: false
    };
  }

  private startStatusMonitoring(): void {
    const statusInterval = setInterval(() => {
      if (!this.isRunning) {
        clearInterval(statusInterval);
        return;
      }
      
      // 计算连接健康统计
      const healthStats = this.getConnectionHealthStats();
      
      logger.info('📊 合约监控状态报告', {
        uptime: Math.floor((Date.now() - this.startTime) / 1000) + 's',
        connections: this.traderClients.size,
        traders: this.traders.length,
        consecutiveErrors: this.consecutiveErrors,
        disconnectedTraders: this.getDisconnectedTraders().length,
        healthyConnections: healthStats.healthy,
        unhealthyConnections: healthStats.unhealthy,
        avgReconnects: healthStats.avgReconnects
      });
      
      // 检查并重连断开的交易员
      this.attemptReconnectDisconnected();
      
      // 定期健康检查
      this.performHealthCheck();
    }, 30000);
  }

  private getConnectionHealthStats() {
    let healthy = 0;
    let unhealthy = 0;
    let totalReconnects = 0;
    
    for (const [address, health] of this.connectionHealth) {
      const isHealthy = health.consecutiveFailures <= 3 && 
                       (Date.now() - health.lastSuccessfulMessage) < 120000; // 2分钟内有消息
      
      if (isHealthy) {
        healthy++;
      } else {
        unhealthy++;
      }
      
      totalReconnects += health.totalReconnects;
    }
    
    return {
      healthy,
      unhealthy,
      avgReconnects: this.connectionHealth.size > 0 ? totalReconnects / this.connectionHealth.size : 0
    };
  }

  private performHealthCheck(): void {
    const now = Date.now();
    const staleThreshold = 180000; // 3分钟没有消息认为连接可能有问题
    
    for (const [address, health] of this.connectionHealth) {
      const trader = this.traders.find(t => t.address === address);
      if (!trader) continue;
      
      const isStale = (now - health.lastSuccessfulMessage) > staleThreshold;
      const hasHighFailures = health.consecutiveFailures > 5;
      
      if (isStale || hasHighFailures) {
        logger.warn(`🔍 ${trader.label} 连接健康检查异常`, {
          isStale,
          hasHighFailures,
          lastMessage: new Date(health.lastSuccessfulMessage).toISOString(),
          consecutiveFailures: health.consecutiveFailures,
          staleDuration: Math.floor((now - health.lastSuccessfulMessage) / 1000) + 's'
        });
        
        // 标记为需要重连
        if (this.traderClients.has(address)) {
          logger.info(`🔄 ${trader.label} 健康检查失败，触发重连`);
          this.traderClients.delete(address);
        }
      }
    }
  }

  private getDisconnectedTraders(): ContractTrader[] {
    return this.traders.filter(trader => !this.traderClients.has(trader.address));
  }

  private async attemptReconnectDisconnected(): Promise<void> {
    const disconnected = this.getDisconnectedTraders();
    
    for (const trader of disconnected) {
      const attempts = this.reconnectAttempts.get(trader.address) || 0;
      
      if (attempts < this.maxReconnectAttempts) {
        logger.info(`🔄 尝试重连 ${trader.label} (尝试 ${attempts + 1}/${this.maxReconnectAttempts})`);
        
        try {
          await this.createSingleConnection(trader, -1); // position -1 表示重连
          this.reconnectAttempts.set(trader.address, 0); // 重置重连计数
          logger.info(`✅ ${trader.label} 重连成功`);
          
        } catch (error) {
          this.reconnectAttempts.set(trader.address, attempts + 1);
          logger.warn(`⚠️ ${trader.label} 重连失败 (${attempts + 1}/${this.maxReconnectAttempts}):`, error);
        }
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    logger.info('⏹️ 停止优化多实例WebSocket合约监控器');
    this.isRunning = false;
    
    for (const [address, clientData] of this.traderClients) {
      const trader = this.traders.find(t => t.address === address);
      const traderLabel = trader?.label || address.slice(0, 8) + '...';
      
      try {
        if (clientData.subscription?.unsubscribe) {
          await clientData.subscription.unsubscribe();
        }
        if (clientData.transport) {
          await clientData.transport.close();
        }
      } catch (error) {
        logger.warn(`⚠️ ${traderLabel} 清理失败:`, error);
      }
    }
    
    this.traderClients.clear();
    logger.info('✅ 优化多实例WebSocket合约监控器已停止');
  }

  getStats() {
    return {
      isRunning: this.isRunning,
      strategy: 'optimized-multi-instance-websocket',
      traders: this.traders.length,
      connections: this.traderClients.size,
      consecutiveErrors: this.consecutiveErrors,
      startTime: this.startTime,
      uptime: this.isRunning ? Date.now() - this.startTime : 0
    };
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      subscribedTraders: this.traders.map(t => ({
        label: t.label,
        address: t.address.slice(0, 8) + '...',
        connected: this.traderClients.has(t.address),
        hasSubscription: !!this.traderClients.get(t.address)?.subscription
      })),
      totalConnections: this.traderClients.size,
      consecutiveErrors: this.consecutiveErrors,
      uptime: this.isRunning ? Date.now() - this.startTime : 0,
      connectionMode: 'optimized-multi-instance'
    };
  }
}
