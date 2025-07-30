import { createClient, RedisClientType } from 'redis';
import config from './config';
import logger from './logger';
import { DailyCache, MonitorEvent, MonitoringStatus } from './types';

export class CacheManager {
  private redis: RedisClientType;
  private isConnected = false;

  constructor() {
    this.redis = createClient({
      url: config.redis.url,
    });

    this.redis.on('error', (err) => {
      logger.error('Redis连接错误:', err);
      this.isConnected = false;
    });

    this.redis.on('connect', () => {
      logger.info('Redis连接已建立');
    });

    this.redis.on('ready', () => {
      logger.info('Redis连接就绪');
      this.isConnected = true;
    });

    this.redis.on('end', () => {
      logger.warn('Redis连接已断开');
      this.isConnected = false;
    });
  }

  async connect(): Promise<void> {
    try {
      await this.redis.connect();
      logger.info('Redis缓存管理器初始化完成', {
        url: config.redis.url,
        keyPrefix: config.redis.keyPrefix
      });
    } catch (error) {
      logger.error('Redis连接失败:', error);
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

  private getKey(type: string, identifier?: string): string {
    return identifier 
      ? `${config.redis.keyPrefix}${type}:${identifier}`
      : `${config.redis.keyPrefix}${type}`;
  }

  // 更新日常缓存数据
  async updateDailyCache(address: string, event: MonitorEvent): Promise<void> {
    if (!this.isConnected) {
      logger.warn('Redis未连接，跳过缓存更新');
      return;
    }

    try {
      const key = this.getKey('daily', address.toLowerCase());
      const amount = parseFloat(event.amount);
      const direction = event.eventType.includes('in') ? 'in' : 'out';

      // 获取现有缓存
      const cached = await this.redis.get(key);
      let dailyCache: DailyCache;

      if (cached) {
        dailyCache = JSON.parse(cached);
      } else {
        dailyCache = {
          totalInbound: '0',
          totalOutbound: '0',
          transactions: [],
          lastReset: Date.now()
        };
      }

      // 检查是否需要重置（24小时后）
      const now = Date.now();
      const hoursElapsed = (now - dailyCache.lastReset) / (1000 * 60 * 60);
      
      if (hoursElapsed >= 24) {
        // 重置24小时数据
        dailyCache = {
          totalInbound: '0',
          totalOutbound: '0',
          transactions: [],
          lastReset: now
        };
        logger.debug('重置24小时累计数据', { address, hoursElapsed });
      }

      // 更新累计金额
      if (direction === 'in') {
        dailyCache.totalInbound = (parseFloat(dailyCache.totalInbound) + amount).toString();
      } else {
        dailyCache.totalOutbound = (parseFloat(dailyCache.totalOutbound) + amount).toString();
      }

      // 添加交易记录
      const transaction = {
        amount: event.amount,
        timestamp: event.timestamp,
        txHash: event.hash,
        type: direction as 'in' | 'out'
      };

      dailyCache.transactions.push(transaction);

      // 保留最近100笔交易记录
      if (dailyCache.transactions.length > 100) {
        dailyCache.transactions = dailyCache.transactions.slice(-100);
      }

      // 保存到Redis，设置25小时TTL
      await this.redis.setEx(key, 25 * 60 * 60, JSON.stringify(dailyCache));

      logger.debug('日常缓存已更新', {
        address,
        direction,
        amount: event.amount,
        totalInbound: dailyCache.totalInbound,
        totalOutbound: dailyCache.totalOutbound,
        transactionCount: dailyCache.transactions.length
      });

    } catch (error) {
      logger.error('更新日常缓存失败:', error, { address, event });
    }
  }

  // 获取日常缓存数据
  async getDailyCache(address: string): Promise<DailyCache | null> {
    if (!this.isConnected) {
      logger.warn('Redis未连接，返回空缓存');
      return null;
    }

    try {
      const key = this.getKey('daily', address.toLowerCase());
      const cached = await this.redis.get(key);

      if (!cached) {
        return null;
      }

      const dailyCache: DailyCache = JSON.parse(cached);

      // 检查数据是否过期
      const now = Date.now();
      const hoursElapsed = (now - dailyCache.lastReset) / (1000 * 60 * 60);
      
      if (hoursElapsed >= 24) {
        // 数据已过期，返回空数据
        logger.debug('缓存数据已过期，返回空数据', { address, hoursElapsed });
        return null;
      }

      return dailyCache;

    } catch (error) {
      logger.error('获取日常缓存失败:', error, { address });
      return null;
    }
  }

  // 更新监控状态
  async updateMonitoringStatus(status: MonitoringStatus): Promise<void> {
    if (!this.isConnected) {
      logger.warn('Redis未连接，跳过状态更新');
      return;
    }

    try {
      const key = this.getKey('status');
      await this.redis.setEx(key, 60 * 60, JSON.stringify(status)); // 1小时TTL
      
      logger.debug('监控状态已更新', status);
    } catch (error) {
      logger.error('更新监控状态失败:', error);
    }
  }

  // 获取监控状态
  async getMonitoringStatus(): Promise<MonitoringStatus | null> {
    if (!this.isConnected) {
      return null;
    }

    try {
      const key = this.getKey('status');
      const cached = await this.redis.get(key);
      
      return cached ? JSON.parse(cached) : null;
    } catch (error) {
      logger.error('获取监控状态失败:', error);
      return null;
    }
  }

  // 清理过期数据
  async cleanup(): Promise<void> {
    if (!this.isConnected) {
      return;
    }

    try {
      // 清理24小时前的数据
      const pattern = this.getKey('daily', '*');
      const keys = await this.redis.keys(pattern);
      
      let cleanedCount = 0;
      for (const key of keys) {
        const cached = await this.redis.get(key);
        if (cached) {
          const dailyCache: DailyCache = JSON.parse(cached);
          const hoursElapsed = (Date.now() - dailyCache.lastReset) / (1000 * 60 * 60);
          
          if (hoursElapsed >= 25) { // 25小时后删除
            await this.redis.del(key);
            cleanedCount++;
          }
        }
      }

      if (cleanedCount > 0) {
        logger.info('清理过期缓存完成', { cleanedCount });
      }

    } catch (error) {
      logger.error('清理缓存失败:', error);
    }
  }

  // 获取缓存统计
  async getStats(): Promise<{
    totalKeys: number;
    dailyCacheKeys: number;
    isConnected: boolean;
  }> {
    if (!this.isConnected) {
      return {
        totalKeys: 0,
        dailyCacheKeys: 0,
        isConnected: false
      };
    }

    try {
      const allKeys = await this.redis.keys(this.getKey('*'));
      const dailyKeys = await this.redis.keys(this.getKey('daily', '*'));

      return {
        totalKeys: allKeys.length,
        dailyCacheKeys: dailyKeys.length,
        isConnected: this.isConnected
      };

    } catch (error) {
      logger.error('获取缓存统计失败:', error);
      return {
        totalKeys: 0,
        dailyCacheKeys: 0,
        isConnected: this.isConnected
      };
    }
  }
}

export default CacheManager;
