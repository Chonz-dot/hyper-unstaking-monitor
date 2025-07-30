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
  
  // 订单聚合管理 - 解决子订单重复警报问题
  private pendingOrderFills = new Map<string, {
    oid: number;
    trader: ContractTrader;
    fills: any[];
    totalSize: number;
    avgPrice: number;
    firstFill: any;
    lastUpdate: number;
  }>();
  private readonly ORDER_COMPLETION_DELAY = 3000; // 3秒内无新fill认为订单完成
  
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

    // 清理可能存在的旧连接
    if (this.connectionPools.size > 0) {
      logger.info('🧹 清理现有连接池...');
      await this.forceCleanupPools();
      // 等待一段时间确保连接完全释放
      await new Promise(resolve => setTimeout(resolve, 10000));
    }

    logger.info('🚀 启动连接池化WebSocket合约监控器');
    this.isRunning = true;
    this.consecutiveErrors = 0;
    
    try {
      await this.createConnectionPools();
      const subscriptionResults = await this.distributeAndSubscribe();
      
      // 计算实际成功率
      const totalSubscriptions = this.getTotalSubscriptions();
      const actualSuccessRate = this.traders.length > 0 ? 
        Math.round((totalSubscriptions / this.traders.length) * 100) : 0;
      
      // 🔥 如果成功率太低，启用降级模式
      if (actualSuccessRate < 50) {
        logger.warn(`🚨 连接池成功率太低 (${actualSuccessRate}%)，启用降级模式...`);
        await this.enableFallbackMode();
        return;
      }
      
      logger.info('✅ 连接池化WebSocket合约监控器启动成功', {
        activeTraders: this.traders.length,
        activePools: this.connectionPools.size,
        successfulSubscriptions: totalSubscriptions,
        actualSuccessRate: `${actualSuccessRate}%`
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
      
      // 增加连接延迟，避免频率限制
      const connectionDelay = poolId * 5000; // 每个连接池延迟5秒
      
      setTimeout(() => {
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
      }, connectionDelay);
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
    logger.info('📋 分配交易员到连接池并序列化订阅...');
    
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
    
    // 🔥 串行化连接池订阅，避免并发压力
    let totalSuccessful = 0;
    let totalFailed = 0;
    
    for (const [poolId, pool] of this.connectionPools) {
      if (pool.traders.length === 0) continue;
      
      logger.info(`📡 连接池${poolId} 开始序列化订阅 ${pool.traders.length} 个交易员...`);
      
      // 每个连接池之间增加延迟，避免API限制
      if (poolId > 0) {
        const poolDelay = 10000; // 连接池间10秒延迟
        logger.info(`⏳ 等待${poolDelay/1000}秒后启动连接池${poolId}订阅...`);
        await new Promise(resolve => setTimeout(resolve, poolDelay));
      }
      
      let successCount = 0;
      let failCount = 0;
      
      for (const trader of pool.traders) {
        let subscribed = false;
        let attempt = 0;
        const maxAttempts = 3;
        
        while (!subscribed && attempt < maxAttempts) {
          try {
            attempt++;
            logger.info(`📡 连接池${poolId} 订阅${trader.label} (尝试 ${attempt}/${maxAttempts})...`);
            
            await this.subscribeTraderInPool(poolId, trader, pool);
            successCount++;
            totalSuccessful++;
            subscribed = true;
            
            // 订阅成功后延迟，避免API限制
            await new Promise(resolve => setTimeout(resolve, 5000)); // 增加到5秒
            
          } catch (error) {
            logger.error(`❌ 连接池${poolId} 订阅${trader.label}失败 (尝试 ${attempt}/${maxAttempts}):`, error);
            
            if (attempt < maxAttempts) {
              // 重试前增加延迟
              const retryDelay = 3000 * attempt;
              logger.info(`⏳ ${retryDelay/1000}秒后重试订阅${trader.label}...`);
              await new Promise(resolve => setTimeout(resolve, retryDelay));
            } else {
              failCount++;
              totalFailed++;
            }
          }
        }
      }
      
      logger.info(`✅ 连接池${poolId} 订阅完成`, {
        totalTraders: pool.traders.length,
        successful: successCount,
        failed: failCount,
        successRate: `${Math.round((successCount / pool.traders.length) * 100)}%`
      });
    }
    
    // 修复：基于实际订阅成功数计算成功率
    const totalAttempts = totalSuccessful + totalFailed;
    const actualSuccessRate = totalAttempts > 0 ? Math.round((totalSuccessful / totalAttempts) * 100) : 0;
    
    logger.info(`📊 整体订阅完成`, {
      totalTraders: this.traders.length,
      totalSuccessful,
      totalFailed,
      actualSuccessRate: `${actualSuccessRate}%`,
      activePools: this.connectionPools.size
    });
    
    // 如果成功率太低，发出警告
    if (actualSuccessRate < 50) {
      logger.warn(`⚠️ 订阅成功率较低 (${actualSuccessRate}%)，可能存在网络或API限制问题`);
    }
  }

  private async subscribeTraderInPool(poolId: number, trader: ContractTrader, pool: any): Promise<void> {
    logger.info(`📡 连接池${poolId} 订阅${trader.label}...`);
    
    try {
      // 使用超时Promise包装订阅调用
      const subscription = await this.subscribeWithTimeout(
        pool.client,
        trader,
        poolId,
        45000 // 增加到45秒超时，应对网络延迟
      );
      
      pool.subscriptions.set(trader.address, subscription);
      logger.info(`🎯 连接池${poolId} ${trader.label} 订阅成功`);
      
    } catch (error) {
      logger.error(`❌ 连接池${poolId} 订阅${trader.label}失败:`, error);
      throw error; // 重新抛出，让上层处理
    }
  }

  private async subscribeWithTimeout(
    client: any,
    trader: ContractTrader,
    poolId: number,
    timeoutMs: number
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      // 设置超时
      const timeout = setTimeout(() => {
        reject(new Error(`连接池${poolId} 订阅${trader.label}超时 (${timeoutMs/1000}秒)`));
      }, timeoutMs);
      
      logger.debug(`🔗 连接池${poolId} 调用${trader.label} userEvents...`, {
        address: trader.address,
        clientReady: client ? 'true' : 'false',
        transportState: client?.transport?.readyState || 'unknown'
      });
      
      // 🔥 添加连接状态检查
      if (!client) {
        clearTimeout(timeout);
        reject(new Error(`连接池${poolId} client未定义`));
        return;
      }
      
      if (!client.transport) {
        clearTimeout(timeout);
        reject(new Error(`连接池${poolId} transport未定义`));
        return;
      }
      
      // 检查transport状态
      client.transport.ready()
        .then(() => {
          logger.debug(`🌐 连接池${poolId} transport就绪，开始订阅${trader.label}...`);
          
          // 调用实际的订阅方法
          return client.userEvents(
            { user: trader.address as `0x${string}` },
            (data: any) => {
              this.handleUserEvent(data, trader, poolId);
            }
          );
        })
        .then((subscription: any) => {
          clearTimeout(timeout);
          logger.debug(`📋 连接池${poolId} ${trader.label} userEvents Promise resolved`);
          resolve(subscription);
        })
        .catch((error: any) => {
          clearTimeout(timeout);
          logger.error(`💥 连接池${poolId} ${trader.label} userEvents Promise rejected:`, {
            error: error instanceof Error ? error.message : String(error),
            errorType: error?.constructor?.name,
            transportState: client.transport?.readyState || 'unknown'
          });
          reject(error);
        });
    });
  }

  private handleUserEvent(data: any, trader: ContractTrader, poolId: number): void {
    try {
      // 🔥 重要：验证事件地址与订阅地址是否匹配
      const actualUserAddress = this.extractUserAddressFromEvent(data);
      if (actualUserAddress && actualUserAddress.toLowerCase() !== trader.address.toLowerCase()) {
        logger.debug(`🔄 连接池${poolId} 跳过非匹配地址事件`, {
          eventAddress: actualUserAddress,
          subscribedAddress: trader.address,
          traderLabel: trader.label
        });
        return; // 地址不匹配，跳过此事件
      }
      
      // 更新连接池健康状态
      const pool = this.connectionPools.get(poolId);
      if (pool) {
        pool.health.lastSuccessfulMessage = Date.now();
        pool.health.consecutiveFailures = 0;
        pool.health.isActive = true;
      }
      
      logger.debug(`📨 连接池${poolId} 收到${trader.label}事件`, {
        eventKeys: Object.keys(data || {}),
        timestamp: new Date().toISOString(),
        verifiedAddress: actualUserAddress
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

  // 从事件数据中提取用户地址
  private extractUserAddressFromEvent(data: any): string | null {
    // 检查不同类型的事件中的用户地址
    if (data.fills && Array.isArray(data.fills) && data.fills.length > 0) {
      // fills事件中可能包含用户地址信息
      return data.fills[0].user || null;
    }
    
    if (data.delta && data.delta.perpetualPosition) {
      // perpetualPosition事件中的用户地址
      return data.delta.perpetualPosition.user || null;
    }
    
    // 其他事件类型的用户地址提取
    if (data.user) {
      return data.user;
    }
    
    return null;
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
      // 检查是否为合约交易（非现货）
      const coin = fill.coin;
      if (!coin || typeof coin !== 'string') {
        continue;
      }

      // 现货资产以@开头，跳过现货交易
      if (coin.startsWith('@')) {
        logger.debug(`⏭️ ${trader.label} 跳过现货交易: ${coin}`);
        continue;
      }

      const size = parseFloat(fill.sz || '0');
      const price = parseFloat(fill.px || '0');
      const notionalValue = Math.abs(size) * price;

      // 检查是否满足最小名义价值
      if (notionalValue < this.minNotionalValue) {
        logger.debug(`⏭️ ${trader.label} 交易金额过小: ${notionalValue} < ${this.minNotionalValue}`);
        continue;
      }

      // 🔥 订单聚合处理 - 解决子订单重复警报
      if (fill.oid) {
        this.handleOrderAggregation(fill, trader);
      } else {
        // 没有oid的填充，直接处理（可能是旧格式或特殊情况）
        this.processSingleFill(fill, trader);
      }
    }
  }

  // 处理订单聚合逻辑
  private handleOrderAggregation(fill: any, trader: ContractTrader): void {
    const oid = fill.oid;
    const key = `${trader.address}-${oid}`;
    
    if (!this.pendingOrderFills.has(key)) {
      // 新订单的第一个填充
      this.pendingOrderFills.set(key, {
        oid: oid,
        trader: trader,
        fills: [fill],
        totalSize: Math.abs(parseFloat(fill.sz)),
        avgPrice: parseFloat(fill.px),
        firstFill: fill,
        lastUpdate: Date.now()
      });
      
      logger.debug(`📊 ${trader.label} 开始聚合订单 ${oid}`, {
        coin: fill.coin,
        initialSize: fill.sz,
        price: fill.px
      });
    } else {
      // 订单的后续填充
      const pending = this.pendingOrderFills.get(key)!;
      pending.fills.push(fill);
      
      // 计算加权平均价格
      const newSize = Math.abs(parseFloat(fill.sz));
      const newPrice = parseFloat(fill.px);
      pending.avgPrice = (pending.avgPrice * pending.totalSize + newPrice * newSize) / (pending.totalSize + newSize);
      pending.totalSize += newSize;
      pending.lastUpdate = Date.now();
      
      logger.debug(`📈 ${trader.label} 订单 ${oid} 新增填充`, {
        coin: fill.coin,
        fillSize: fill.sz,
        totalSize: pending.totalSize,
        avgPrice: pending.avgPrice,
        fillsCount: pending.fills.length
      });
    }
    
    // 设置订单完成检查
    setTimeout(() => {
      this.checkCompletedOrder(key, trader);
    }, this.ORDER_COMPLETION_DELAY);
  }

  // 检查订单是否完成
  private checkCompletedOrder(key: string, trader: ContractTrader): void {
    const pending = this.pendingOrderFills.get(key);
    if (!pending) return;
    
    const now = Date.now();
    if (now - pending.lastUpdate >= this.ORDER_COMPLETION_DELAY) {
      // 订单完成！发送聚合后的警报
      logger.info(`✅ ${trader.label} 订单 ${pending.oid} 完成聚合`, {
        totalFills: pending.fills.length,
        totalSize: pending.totalSize,
        avgPrice: pending.avgPrice,
        coin: pending.firstFill.coin
      });
      
      this.emitAggregatedOrder(pending);
      this.pendingOrderFills.delete(key);
    }
  }

  // 发送聚合后的订单事件
  private emitAggregatedOrder(aggregatedOrder: any): void {
    const fill = aggregatedOrder.firstFill;
    const trader = aggregatedOrder.trader;
    
    // 使用聚合后的数据创建事件
    const aggregatedFill = {
      ...fill,
      sz: aggregatedOrder.totalSize.toString(),
      px: aggregatedOrder.avgPrice.toString(),
      // 标记为聚合订单
      isAggregated: true,
      originalFillsCount: aggregatedOrder.fills.length,
      aggregatedSize: aggregatedOrder.totalSize,
      aggregatedPrice: aggregatedOrder.avgPrice
    };
    
    const signal = this.convertFillToContractSignal(aggregatedFill, trader);
    if (signal) {
      // 添加聚合信息到metadata
      signal.metadata = {
        ...signal.metadata,
        isAggregated: true,
        originalFillsCount: aggregatedOrder.fills.length,
        aggregationTimespan: Date.now() - aggregatedOrder.fills[0].time
      };
      
      logger.debug(`🎯 ${trader.label} 发送聚合订单警报:`, {
        asset: signal.asset,
        size: signal.size,
        side: signal.side,
        eventType: signal.eventType,
        fillsCount: aggregatedOrder.fills.length
      });
      
      this.emit('contractEvent', signal, trader);
    }
  }

  // 处理单个填充（无oid或特殊情况）
  private processSingleFill(fill: any, trader: ContractTrader): void {
    const signal = this.convertFillToContractSignal(fill, trader);
    if (signal) {
      logger.debug(`🎯 ${trader.label} 处理单个合约交易:`, {
        asset: signal.asset,
        size: signal.size,
        side: signal.side,
        eventType: signal.eventType
      });
      this.emit('contractEvent', signal, trader);
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
    const isAggregated = event.metadata?.isAggregated || false;
    const originalFillsCount = event.metadata?.originalFillsCount || 1;
    
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
      mergedCount: originalFillsCount,
      originalFillsCount: originalFillsCount,
      isMerged: isAggregated
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
        totalSubscriptions: healthStats.totalSubscriptions,
        pendingOrders: this.pendingOrderFills.size // 新增：显示待聚合订单数
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
    const staleThreshold = 180000; // 3分钟没有消息认为连接有问题
    const criticalThreshold = 300000; // 5分钟认为严重问题，需要重连
    
    for (const [poolId, pool] of this.connectionPools) {
      const timeSinceLastMessage = now - pool.health.lastSuccessfulMessage;
      const isStale = timeSinceLastMessage > staleThreshold;
      const isCritical = timeSinceLastMessage > criticalThreshold;
      const hasHighFailures = pool.health.consecutiveFailures > 8;
      
      if (isCritical || hasHighFailures) {
        logger.error(`🚨 连接池${poolId} 严重异常，启动重连`, {
          timeSinceLastMessage: Math.floor(timeSinceLastMessage / 1000) + 's',
          consecutiveFailures: pool.health.consecutiveFailures,
          isCritical,
          hasHighFailures,
          tradersCount: pool.traders.length
        });
        
        // 🔥 主动重连异常的连接池
        this.reconnectPool(poolId, pool).catch(error => {
          logger.error(`❌ 连接池${poolId} 重连失败:`, error);
        });
        
      } else if (isStale) {
        logger.warn(`🔍 连接池${poolId} 健康检查异常`, {
          isStale,
          hasHighFailures,
          lastMessage: new Date(pool.health.lastSuccessfulMessage).toISOString(),
          consecutiveFailures: pool.health.consecutiveFailures,
          staleDuration: Math.floor(timeSinceLastMessage / 1000) + 's',
          tradersCount: pool.traders.length
        });
        
        // 标记为不活跃，但还不到重连阈值
        pool.health.isActive = false;
      }
    }
  }

  // 🔥 新增：连接池重连机制
  private async reconnectPool(poolId: number, oldPool: any): Promise<void> {
    try {
      logger.info(`🔄 开始重连连接池${poolId}...`);
      
      // 清理旧连接
      try {
        for (const [address, subscription] of oldPool.subscriptions) {
          if (subscription?.unsubscribe) {
            await subscription.unsubscribe();
          }
        }
        if (oldPool.transport) {
          await oldPool.transport.close();
        }
      } catch (error) {
        logger.debug(`清理连接池${poolId}旧连接时出错:`, error);
      }
      
      // 创建新的连接和客户端
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
          connectionDelay: (attempt: number) => Math.min(2000 * Math.pow(2, attempt - 1), 32000),
          shouldReconnect: (error: any) => {
            const errorMessage = error?.message?.toLowerCase() || '';
            if (errorMessage.includes('unauthorized') || errorMessage.includes('forbidden')) {
              logger.error(`连接池${poolId} 认证错误，停止重连`, { error: errorMessage });
              return false;
            }
            return true;
          }
        },
        autoResubscribe: true,
      });

      const client = new hl.SubscriptionClient({ transport });
      
      // 等待连接就绪
      await this.waitForConnection(transport, poolId, 30000);
      
      // 更新连接池
      const newPool = {
        transport,
        client,
        traders: oldPool.traders, // 保持原有的交易员分配
        subscriptions: new Map(),
        health: {
          lastPingTime: Date.now(),
          consecutiveFailures: 0,
          totalReconnects: oldPool.health.totalReconnects + 1,
          lastSuccessfulMessage: Date.now(),
          isActive: true
        }
      };
      
      this.connectionPools.set(poolId, newPool);
      
      // 重新订阅所有交易员
      logger.info(`🔄 连接池${poolId} 重新订阅 ${newPool.traders.length} 个交易员...`);
      
      for (const trader of newPool.traders) {
        try {
          await this.subscribeTraderInPool(poolId, trader, newPool);
          await new Promise(resolve => setTimeout(resolve, 5000)); // 增加订阅间隔到5秒
        } catch (error) {
          logger.error(`❌ 连接池${poolId} 重连订阅${trader.label}失败:`, error);
        }
      }
      
      logger.info(`✅ 连接池${poolId} 重连完成`, {
        tradersCount: newPool.traders.length,
        subscriptionsCount: newPool.subscriptions.size,
        totalReconnects: newPool.health.totalReconnects
      });
      
    } catch (error) {
      logger.error(`💥 连接池${poolId} 重连过程失败:`, error);
      
      // 重连失败，标记连接池为失效
      const pool = this.connectionPools.get(poolId);
      if (pool) {
        pool.health.isActive = false;
        pool.health.consecutiveFailures++;
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    logger.info('⏹️ 停止连接池化WebSocket合约监控器');
    this.isRunning = false;
    
    // 清理pending订单
    logger.info(`🧹 清理 ${this.pendingOrderFills.size} 个待聚合订单`);
    this.pendingOrderFills.clear();
    
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

  // 强制清理所有连接池（用于重启时的彻底清理）
  private async forceCleanupPools(): Promise<void> {
    logger.info('🧹 强制清理所有连接池...');
    
    for (const [poolId, pool] of this.connectionPools) {
      try {
        // 强制取消所有订阅
        for (const [address, subscription] of pool.subscriptions) {
          try {
            if (subscription?.unsubscribe) {
              await Promise.race([
                subscription.unsubscribe(),
                new Promise((_, reject) => 
                  setTimeout(() => reject(new Error('取消订阅超时')), 5000)
                )
              ]);
            }
          } catch (error) {
            logger.debug(`强制取消订阅失败 ${address}:`, error);
          }
        }
        
        // 强制关闭连接
        try {
          if (pool.transport) {
            await Promise.race([
              pool.transport.close(),
              new Promise((_, reject) => 
                setTimeout(() => reject(new Error('关闭连接超时')), 3000)
              )
            ]);
          }
        } catch (error) {
          logger.debug(`强制关闭连接失败 池${poolId}:`, error);
        }
        
        logger.debug(`清理连接池${poolId}完成`);
      } catch (error) {
        logger.warn(`强制清理连接池${poolId}失败:`, error);
      }
    }
    
    this.connectionPools.clear();
    logger.info('✅ 强制清理完成');
  }

  // 🔥 降级模式：使用单个连接订阅所有交易员
  private async enableFallbackMode(): Promise<void> {
    logger.info('🛡️ 启用连接池降级模式 - 使用单连接...');
    
    try {
      // 清理失败的连接池
      await this.stop();
      
      // 创建单个可靠连接
      const transport = new hl.WebSocketTransport({
        url: config.hyperliquid.wsUrl,
        timeout: 60000, // 增加到60秒超时
        keepAlive: { 
          interval: 30000,
          timeout: 20000
        },
        reconnect: {
          maxRetries: 50,
          connectionTimeout: 60000,
          connectionDelay: (attempt: number) => Math.min(3000 * attempt, 30000),
          shouldReconnect: () => true
        },
        autoResubscribe: true,
      });

      const client = new hl.SubscriptionClient({ transport });
      
      // 等待连接就绪
      await this.waitForConnection(transport, 99, 45000);
      
      // 创建降级连接池
      const fallbackPool = {
        transport,
        client,
        traders: [...this.traders],
        subscriptions: new Map(),
        health: {
          lastPingTime: Date.now(),
          consecutiveFailures: 0,
          totalReconnects: 0,
          lastSuccessfulMessage: Date.now(),
          isActive: true
        }
      };
      
      this.connectionPools.clear();
      this.connectionPools.set(99, fallbackPool); // 特殊ID 99表示降级模式
      
      // 逐个订阅交易员，增加延迟
      let successCount = 0;
      for (const trader of this.traders) {
        try {
          logger.info(`📡 降级模式订阅${trader.label}...`);
          
          const subscription = await client.userEvents(
            { user: trader.address as `0x${string}` },
            (data: any) => this.handleUserEvent(data, trader, 99)
          );
          
          fallbackPool.subscriptions.set(trader.address, subscription);
          successCount++;
          
          logger.info(`✅ 降级模式${trader.label}订阅成功`);
          
          // 降级模式使用更长延迟确保稳定
          await new Promise(resolve => setTimeout(resolve, 8000));
          
        } catch (error) {
          logger.error(`❌ 降级模式${trader.label}订阅失败:`, error);
        }
      }
      
      logger.info('✅ 降级模式启动完成', {
        mode: 'fallback-single-connection',
        totalTraders: this.traders.length,
        successfulSubscriptions: successCount,
        successRate: `${Math.round((successCount / this.traders.length) * 100)}%`
      });
      
      this.startHealthMonitoring();
      
    } catch (error) {
      logger.error('💥 降级模式启动失败:', error);
      throw error;
    }
  }

  // 获取所有连接池的总订阅数
  private getTotalSubscriptions(): number {
    let total = 0;
    for (const [poolId, pool] of this.connectionPools) {
      total += pool.subscriptions.size;
    }
    return total;
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
