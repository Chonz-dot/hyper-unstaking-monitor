import Redis from 'redis';
import config from './config';
import logger from './logger';
import { DailyCache } from './types';

export class CacheManager {
  private redis: Redis.RedisClientType;
  private isConnected = false;

  constructor() {
    this.redis = Redis.createClient({
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

  // 获取24小时累计数据
  async getDailyCache(address: string): Promise<DailyCache[string] | null> {
    try {
      const key = this.getKey(`daily:${address}`);
      const data = await this.redis.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      logger.error(`获取日缓存失败 ${address}:`, error);
      return null;
    }
  }

  // 更新24小时累计数据
  async updateDailyCache(
    address: string,
    amount: string,
    txHash: string,
    direction: 'in' | 'out'
  ): Promise<void> {
    try {
      const key = this.getKey(`daily:${address}`);
      const now = Date.now();
      const dayStart = this.getDayStart(now);
      
      let cache = await this.getDailyCache(address);
      
      if (!cache || cache.lastReset < dayStart) {
        // 新的一天，重置缓存
        cache = {
          totalInbound: '0',
          totalOutbound: '0',
          transactions: [],
          lastReset: dayStart,
        };
      }

      // 添加新交易
      cache.transactions.push({
        amount,
        timestamp: now,
        txHash,
        direction,
      });

      // 更新累计金额
      const amountNum = parseFloat(amount);
      if (direction === 'in') {
        cache.totalInbound = (parseFloat(cache.totalInbound) + amountNum).toString();
      } else {
        cache.totalOutbound = (parseFloat(cache.totalOutbound) + amountNum).toString();
      }

      // 保存到Redis，25小时TTL
      await this.redis.setEx(key, 25 * 60 * 60, JSON.stringify(cache));
      
    } catch (error) {
      logger.error(`更新日缓存失败 ${address}:`, error);
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

  // 获取当天开始时间戳
  private getDayStart(timestamp: number): number {
    const date = new Date(timestamp);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
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
