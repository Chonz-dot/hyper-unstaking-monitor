import { createClient, RedisClientType } from 'redis';
import config from './config';
import logger from './logger';
import { DailyCache } from './types';
import { SYSTEM_START_TIME } from './index';

export class CacheManager {
  private redis: RedisClientType;
  private isConnected = false;

  constructor() {
    this.redis = createClient({
      url: config.redis.url,
    });

    this.redis.on('error', (err) => {
      logger.error('Redis连接错误:', err);
    });

    this.redis.on('connect', () => {
      logger.info('Redis连接成功');
      this.isConnected = true;
    });

    this.redis.on('disconnect', () => {
      logger.warn('Redis连接断开');
      this.isConnected = false;
    });
  }

  async connect(): Promise<void> {
    try {
      await this.redis.connect();
      logger.info('Redis客户端连接建立');
    } catch (error) {
      logger.error('连接Redis失败:', error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.redis.disconnect();
      logger.info('Redis连接已关闭');
    } catch (error) {
      logger.error('关闭Redis连接失败:', error);
    }
  }

  private getKey(suffix: string): string {
    return `${config.redis.keyPrefix}${suffix}`;
  }

  // 获取24小时累计数据（基于系统启动时间）
  async get24HourCache(address: string): Promise<DailyCache[string] | null> {
    try {
      const key = this.getKey(`24hour:${address}`);
      const data = await this.redis.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      logger.error(`获取24小时缓存失败 ${address}:`, error);
      return null;
    }
  }

  // 更新24小时累计数据（基于系统启动时间）
  async update24HourCache(
    address: string,
    amount: string,
    txHash: string,
    direction: 'in' | 'out',
    eventTimestamp: number
  ): Promise<void> {
    try {
      // 验证事件是否在系统启动后发生
      if (eventTimestamp < SYSTEM_START_TIME) {
        logger.debug(`跳过系统启动前的历史交易: ${txHash.substring(0, 10)}...`, {
          eventTime: new Date(eventTimestamp).toISOString(),
          systemStartTime: new Date(SYSTEM_START_TIME).toISOString()
        });
        return;
      }

      const key = this.getKey(`24hour:${address}`);
      const windowStart = this.get24HourWindowStart();
      
      let cache = await this.get24HourCache(address);
      
      if (!cache || cache.lastReset < windowStart) {
        // 新的24小时窗口，重置缓存
        cache = {
          totalInbound: '0',
          totalOutbound: '0',
          transactions: [],
          lastReset: windowStart,
        };
      }

      // 过滤出当前24小时窗口内的交易
      cache.transactions = cache.transactions.filter(tx => tx.timestamp >= windowStart);

      // 添加新交易
      cache.transactions.push({
        amount,
        timestamp: eventTimestamp,
        txHash,
        direction,
      });

      // 重新计算累计金额（基于过滤后的交易）
      let totalInbound = 0;
      let totalOutbound = 0;
      
      for (const tx of cache.transactions) {
        const txAmount = parseFloat(tx.amount);
        if (tx.direction === 'in') {
          totalInbound += txAmount;
        } else {
          totalOutbound += txAmount;
        }
      }

      cache.totalInbound = totalInbound.toString();
      cache.totalOutbound = totalOutbound.toString();

      // 保存到Redis，25小时TTL
      await this.redis.setEx(key, 25 * 60 * 60, JSON.stringify(cache));
      
      logger.debug(`更新24小时缓存: ${address}`, {
        direction,
        amount,
        totalInbound: cache.totalInbound,
        totalOutbound: cache.totalOutbound,
        transactionCount: cache.transactions.length,
        windowStart: new Date(windowStart).toISOString()
      });
      
    } catch (error) {
      logger.error(`更新24小时缓存失败 ${address}:`, error);
    }
  }

  // 检查交易是否已处理（去重）
  async isTransactionProcessed(txHash: string): Promise<boolean> {
    try {
      const key = this.getKey(`processed:${txHash}`);
      const exists = await this.redis.exists(key);
      return exists === 1;
    } catch (error) {
      logger.error(`检查交易处理状态失败 ${txHash}:`, error);
      return false;
    }
  }

  // 标记交易已处理
  async markTransactionProcessed(txHash: string): Promise<void> {
    try {
      const key = this.getKey(`processed:${txHash}`);
      // 25小时TTL，确保去重窗口
      await this.redis.setEx(key, 25 * 60 * 60, '1');
    } catch (error) {
      logger.error(`标记交易处理失败 ${txHash}:`, error);
    }
  }

  // 获取24小时窗口开始时间戳（基于系统启动时间）
  private get24HourWindowStart(): number {
    const now = Date.now();
    const hoursFromStart = Math.floor((now - SYSTEM_START_TIME) / (24 * 60 * 60 * 1000));
    return SYSTEM_START_TIME + (hoursFromStart * 24 * 60 * 60 * 1000);
  }

  // 兼容性方法：getDailyCache -> get24HourCache
  async getDailyCache(address: string): Promise<DailyCache[string] | null> {
    return this.get24HourCache(address);
  }

  // 兼容性方法：updateDailyCache -> update24HourCache
  async updateDailyCache(
    address: string,
    amount: string,
    txHash: string,
    direction: 'in' | 'out',
    eventTimestamp?: number
  ): Promise<void> {
    // 如果没有提供事件时间戳，使用当前时间（用于实时事件）
    const timestamp = eventTimestamp || Date.now();
    return this.update24HourCache(address, amount, txHash, direction, timestamp);
  }

  // 获取监控状态
  async getMonitoringStatus(): Promise<{ startTime: number; lastUpdate: number } | null> {
    try {
      const key = this.getKey('status');
      const data = await this.redis.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      logger.error('获取监控状态失败:', error);
      return null;
    }
  }

  // 更新监控状态
  async updateMonitoringStatus(status: { startTime: number; lastUpdate: number }): Promise<void> {
    try {
      const key = this.getKey('status');
      await this.redis.set(key, JSON.stringify(status));
    } catch (error) {
      logger.error('更新监控状态失败:', error);
    }
  }
}

export default CacheManager;
