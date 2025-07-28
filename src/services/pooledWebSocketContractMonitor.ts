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
 * 连接池化的WebSocket合约监控器
 * 使用少数几个共享连接处理所有交易员的订阅，提高稳定性
 */
export class PooledWebSocketContractMonitor extends EventEmitter {
  private traders: ContractTrader[];
  private minNotionalValue: number;
  private isRunning = false;
  private startTime: number;
  private consecutiveErrors = 0;
  private maxConsecutiveErrors: number;
  
  // 连接池配置
  private readonly POOL_SIZE = 2; // 使用2个连接池
  private connectionPools = new Map<number, {
    transport: hl.WebSocketTransport;
    client: hl.SubscriptionClient;
    traders: ContractTrader[];
    subscriptions: Map<string, any>;
    health: {
      lastPingTime: number;
      consecutiveFailures: number;
      totalReconnects: number;
      lastSuccessfulMessage: number;
      isActive: boolean;
    };
  }>();

  constructor(traders: ContractTrader[], minNotionalValue = 10) {
    super();
    this.traders = traders.filter(t => t.isActive);
    this.minNotionalValue = minNotionalValue;
    this.startTime = Date.now();
    this.maxConsecutiveErrors = config.hyperliquid.maxConsecutiveErrors;
    
    logger.info('🔄 初始化连接池化WebSocket合约监控器', {
      activeTraders: this.traders.length,
      poolSize: this.POOL_SIZE,
      minNotionalValue,
      startTime: new Date(this.startTime).toISOString(),
      architecture: '连接池化 - 多交易员共享连接'
    });
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('连接池化WebSocket合约监控器已在运行');
      return;
    }

    logger.info('🚀 启动连接池化WebSocket合约监控器');
    this.isRunning = true;
    this.consecutiveErrors = 0;
    
    try {
      await this.createConnectionPools();
      await this.distributeAndSubscribe();
      
      logger.info('✅ 连接池化WebSocket合约监控器启动成功', {
        activeTraders: this.traders.length,
        activePools: this.connectionPools.size,
        successRate: `${Math.round((this.connectionPools.size / this.POOL_SIZE) * 100)}%`
      });
      
      this.startHealthMonitoring();
      
    } catch (error) {
      logger.error('连接池化WebSocket合约监控器启动失败:', error);
      this.isRunning = false;
      throw error;
    }
  }

  private async createConnectionPools(): Promise<void> {
    logger.info('🏊 创建连接池...');
    
    for (let poolId = 0; poolId < this.POOL_SIZE; poolId++) {
      try {
        const transport = new hl.WebSocketTransport({
          url: config.hyperliquid.wsUrl,
          timeout: 45000,
          keepAlive: { 
            interval: 25000,
            timeout: 15000
          },
          reconnect: {
            maxRetries: 30,
            connectionTimeout: 45000,
            connectionDelay: (attempt: number) => {
              // 渐进退避：2s, 4s, 8s, 16s, 32s(最大)
              return Math.min(2000 * Math.pow(2, attempt - 1), 32000);
            },
            shouldReconnect: (error: any) => {
              const pool = this.connectionPools.get(poolId);
              if (!pool) return false;
              
              if (this.consecutiveErrors > this.maxConsecutiveErrors) {
                logger.error(`连接池${poolId} 连续错误过多，停止重连`, { 
                  consecutiveErrors: this.consecutiveErrors 
                });
                return false;
              }
              
              // 检查错误类型
              const errorMessage = error?.message?.toLowerCase() || '';
              if (errorMessage.includes('unauthorized') || errorMessage.includes('forbidden')) {
                logger.error(`连接池${poolId} 认证错误，停止重连`, { error: errorMessage });
                return false;
              }
              
              pool.health.totalReconnects++;
              logger.debug(`连接池${poolId} 将尝试重连`, { 
                error: errorMessage, 
                reconnectCount: pool.health.totalReconnects 
              });
              return true;
            }
          },
          autoResubscribe: true, // 自动重订阅
        });

        const client = new hl.SubscriptionClient({ transport });
        
        // 等待连接就绪
        logger.info(`🔗 连接池${poolId} 等待连接建立...`);
        await this.waitForConnection(transport, poolId, 30000);
        
        const pool = {
          transport,
          client,
          traders: [],
          subscriptions: new Map(),
          health: {
            lastPingTime: Date.now(),
            consecutiveFailures: 0,
            totalReconnects: 0,
            lastSuccessfulMessage: Date.now(),
            isActive: true
          }
        };
        
        this.connectionPools.set(poolId, pool);
        logger.info(`✅ 连接池${poolId} 创建成功`);
        
        // 添加连接错误监听
        this.setupPoolErrorHandling(poolId, pool);
        
        // 连接间隔，避免同时创建过多连接
        if (poolId < this.POOL_SIZE - 1) {
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
        
      } catch (error) {
        logger.error(`❌ 连接池${poolId} 创建失败:`, error);
        this.consecutiveErrors++;
      }
    }
    
    if (this.connectionPools.size === 0) {
      throw new Error('所有连接池都创建失败');
    }
    
    logger.info(`📊 连接池创建完成: ${this.connectionPools.size}/${this.POOL_SIZE}`);
  }

  private async waitForConnection(transport: hl.WebSocketTransport, poolId: number, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`连接池${poolId}连接超时 (${timeoutMs/1000}秒)`));
      }, timeoutMs);
      
      transport.ready()
        .then(() => {
          clearTimeout(timeout);
          logger.info(`✅ 连接池${poolId}连接就绪`);
          resolve();
        })
        .catch((error) => {
          clearTimeout(timeout);
          logger.error(`❌ 连接池${poolId}连接失败:`, error);
          reject(error);
        });
    });
  }

  private setupPoolErrorHandling(poolId: number, pool: any): void {
    pool.transport.ready()
      .then(() => {
        pool.health.consecutiveFailures = 0;
        pool.health.lastPingTime = Date.now();
        pool.health.isActive = true;
        logger.debug(`🔄 连接池${poolId} 健康状态重置`);
      })
      .catch((error: any) => {
        pool.health.consecutiveFailures++;
        pool.health.isActive = false;
        logger.error(`❌ 连接池${poolId} 错误:`, error);
        this.consecutiveErrors++;
      });
  }

  private async distributeAndSubscribe(): Promise<void> {
    logger.info('📋 分配交易员到连接池并订阅...');
    
    // 将交易员平均分配到不同的连接池
    const pools = Array.from(this.connectionPools.keys());
    for (let i = 0; i < this.traders.length; i++) {
      const trader = this.traders[i];
      const poolId = pools[i % pools.length];
      const pool = this.connectionPools.get(poolId);
      
      if (pool) {
        pool.traders.push(trader);
        logger.info(`👤 ${trader.label} 分配到连接池${poolId}`);
      }
    }
    
    // 为每个连接池订阅所有分配的交易员
    for (const [poolId, pool] of this.connectionPools) {
      if (pool.traders.length === 0) continue;
      
      logger.info(`📡 连接池${poolId} 开始订阅 ${pool.traders.length} 个交易员...`);
      
      for (const trader of pool.traders) {
        try {
          await this.subscribeTraderInPool(poolId, trader, pool);
          
          // 订阅间隔，避免API限制
          await new Promise(resolve => setTimeout(resolve, 2000));
          
        } catch (error) {
          logger.error(`❌ 连接池${poolId} 订阅${trader.label}失败:`, error);
        }
      }
      
      logger.info(`✅ 连接池${poolId} 订阅完成`);
    }
  }

  private async subscribeTraderInPool(poolId: number, trader: ContractTrader, pool: any): Promise<void> {
    logger.info(`📡 连接池${poolId} 订阅${trader.label}...`);
    
    const subscription = await pool.client.userEvents(
      { user: trader.address as `0x${string}` },
      (data: any) => {
        this.handleUserEvent(data, trader, poolId);
      }
    );
    
    pool.subscriptions.set(trader.address, subscription);
    logger.info(`🎯 连接池${poolId} ${trader.label} 订阅成功`);
  }

  private handleUserEvent(data: any, trader: ContractTrader, poolId: number): void {
    try {
      // 更新连接池健康状态
      const pool = this.connectionPools.get(poolId);
      if (pool) {
        pool.health.lastSuccessfulMessage = Date.now();
        pool.health.consecutiveFailures = 0;
        pool.health.isActive = true;
      }
      
      logger.debug(`📨 连接池${poolId} 收到${trader.label}事件`, {
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
      
    } catch (error) {
      logger.error(`连接池${poolId} 处理${trader.label}事件失败:`, error);
      this.consecutiveErrors++;
      
      // 更新连接池健康状态
      const pool = this.connectionPools.get(poolId);
      if (pool) {
        pool.health.consecutiveFailures++;
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
      const side = fill.side === 'B' ? 'long' : 'short';
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
          source: 'websocket-fills-pooled',
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
          source: 'websocket-perpetualPosition-pooled',
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

  private startHealthMonitoring(): void {
    const statusInterval = setInterval(() => {
      if (!this.isRunning) {
        clearInterval(statusInterval);
        return;
      }
      
      const healthStats = this.getPoolsHealthStats();
      
      logger.info('📊 连接池化合约监控状态报告', {
        uptime: Math.floor((Date.now() - this.startTime) / 1000) + 's',
        activePools: healthStats.activePools,
        totalPools: this.POOL_SIZE,
        totalTraders: this.traders.length,
        consecutiveErrors: this.consecutiveErrors,
        avgReconnectsPerPool: healthStats.avgReconnects,
        healthyPools: healthStats.healthyPools,
        totalSubscriptions: healthStats.totalSubscriptions
      });
      
      // 检查和修复不健康的连接池
      this.performPoolHealthCheck();
      
    }, 30000);
  }

  private getPoolsHealthStats() {
    let activePools = 0;
    let healthyPools = 0;
    let totalReconnects = 0;
    let totalSubscriptions = 0;
    
    for (const [poolId, pool] of this.connectionPools) {
      if (pool.health.isActive) {
        activePools++;
      }
      
      const isHealthy = pool.health.consecutiveFailures <= 3 && 
                       (Date.now() - pool.health.lastSuccessfulMessage) < 120000;
      
      if (isHealthy) {
        healthyPools++;
      }
      
      totalReconnects += pool.health.totalReconnects;
      totalSubscriptions += pool.subscriptions.size;
    }
    
    return {
      activePools,
      healthyPools,
      avgReconnects: this.connectionPools.size > 0 ? totalReconnects / this.connectionPools.size : 0,
      totalSubscriptions
    };
  }

  private performPoolHealthCheck(): void {
    const now = Date.now();
    const staleThreshold = 300000; // 5分钟没有消息认为连接有问题
    
    for (const [poolId, pool] of this.connectionPools) {
      const isStale = (now - pool.health.lastSuccessfulMessage) > staleThreshold;
      const hasHighFailures = pool.health.consecutiveFailures > 8;
      
      if (isStale || hasHighFailures) {
        logger.warn(`🔍 连接池${poolId} 健康检查异常`, {
          isStale,
          hasHighFailures,
          lastMessage: new Date(pool.health.lastSuccessfulMessage).toISOString(),
          consecutiveFailures: pool.health.consecutiveFailures,
          staleDuration: Math.floor((now - pool.health.lastSuccessfulMessage) / 1000) + 's',
          tradersCount: pool.traders.length
        });
        
        // 标记为不活跃，等待自动重连
        pool.health.isActive = false;
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    logger.info('⏹️ 停止连接池化WebSocket合约监控器');
    this.isRunning = false;
    
    for (const [poolId, pool] of this.connectionPools) {
      try {
        // 取消所有订阅
        for (const [address, subscription] of pool.subscriptions) {
          if (subscription?.unsubscribe) {
            await subscription.unsubscribe();
          }
        }
        
        // 关闭连接
        if (pool.transport) {
          await pool.transport.close();
        }
        
        logger.info(`✅ 连接池${poolId} 已清理`);
      } catch (error) {
        logger.warn(`⚠️ 连接池${poolId} 清理失败:`, error);
      }
    }
    
    this.connectionPools.clear();
    logger.info('✅ 连接池化WebSocket合约监控器已停止');
  }

  getStats() {
    const healthStats = this.getPoolsHealthStats();
    
    return {
      isRunning: this.isRunning,
      strategy: 'pooled-websocket',
      traders: this.traders.length,
      activePools: healthStats.activePools,
      totalPools: this.POOL_SIZE,
      consecutiveErrors: this.consecutiveErrors,
      startTime: this.startTime,
      uptime: this.isRunning ? Date.now() - this.startTime : 0,
      healthyPools: healthStats.healthyPools,
      totalSubscriptions: healthStats.totalSubscriptions
    };
  }

  getStatus() {
    const poolStatus = [];
    
    for (const [poolId, pool] of this.connectionPools) {
      poolStatus.push({
        poolId,
        isActive: pool.health.isActive,
        tradersCount: pool.traders.length,
        subscriptionsCount: pool.subscriptions.size,
        consecutiveFailures: pool.health.consecutiveFailures,
        totalReconnects: pool.health.totalReconnects,
        lastMessage: new Date(pool.health.lastSuccessfulMessage).toISOString(),
        traders: pool.traders.map(t => ({
          label: t.label,
          address: t.address.slice(0, 8) + '...'
        }))
      });
    }
    
    return {
      isRunning: this.isRunning,
      connectionMode: 'pooled-websocket',
      pools: poolStatus,
      totalConnections: this.connectionPools.size,
      consecutiveErrors: this.consecutiveErrors,
      uptime: this.isRunning ? Date.now() - this.startTime : 0
    };
  }
}

export default PooledWebSocketContractMonitor;
