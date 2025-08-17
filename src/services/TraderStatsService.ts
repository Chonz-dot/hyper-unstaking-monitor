import { createClient, RedisClientType } from 'redis';
import config from '../config';
import logger from '../logger';
import { ContractTrader } from '../types';

export interface TraderStats {
  // 基础统计
  totalTrades: number;           // 累计交易次数
  totalVolume: number;           // 累计交易量(USD)
  monitoringStartTime: number;   // 监控开始时间
  
  // 胜率统计
  totalClosedPositions: number;  // 总平仓次数
  profitablePositions: number;   // 盈利平仓次数
  winRate: number;              // 胜率 = profitablePositions / totalClosedPositions
  
  // 盈亏统计
  totalRealizedPnL: number;     // 累计已实现盈亏
  largestWin: number;           // 最大单笔盈利
  largestLoss: number;          // 最大单笔亏损
  
  // 当前统计
  lastTradeTime: number;        // 最后交易时间
  lastUpdateTime: number;       // 最后更新时间
}

export interface PositionInfo {
  asset: string;
  size: number;
  entryPrice: number;
  totalNotional: number;        // 开仓总金额
  openTime: number;            // 开仓时间
  unrealizedPnL?: number;      // 未实现盈亏
}

export class TraderStatsService {
  private redis: RedisClientType;
  private readonly STATS_KEY_PREFIX = 'trader_stats:';
  private readonly POSITION_KEY_PREFIX = 'trader_positions:';
  
  constructor() {
    this.redis = createClient({
      url: config.redis.url,
    });
    
    this.redis.on('error', (err) => {
      logger.error('📊 TraderStats Redis连接错误:', err);
    });
    
    logger.info('📊 交易员统计服务初始化完成', {
      keyPrefix: this.STATS_KEY_PREFIX,
      features: ['交易次数', '胜率统计', '盈亏追踪', '开仓信息']
    });
  }

  /**
   * 连接到Redis
   */
  async connect(): Promise<void> {
    if (!this.redis.isOpen) {
      await this.redis.connect();
      logger.info('📊 TraderStats Redis连接成功');
    }
  }

  /**
   * 断开Redis连接
   */
  async disconnect(): Promise<void> {
    if (this.redis.isOpen) {
      await this.redis.disconnect();
      logger.info('📊 TraderStats Redis连接已断开');
    }
  }

  /**
   * 获取交易员统计数据
   */
  async getTraderStats(traderAddress: string): Promise<TraderStats> {
    try {
      const statsKey = `${this.STATS_KEY_PREFIX}${traderAddress}`;
      const rawStats = await this.redis.hGetAll(statsKey);
      
      if (!rawStats || Object.keys(rawStats).length === 0) {
        // 初始化新交易员统计
        const initialStats: TraderStats = {
          totalTrades: 0,
          totalVolume: 0,
          monitoringStartTime: Date.now(),
          totalClosedPositions: 0,
          profitablePositions: 0,
          winRate: 0,
          totalRealizedPnL: 0,
          largestWin: 0,
          largestLoss: 0,
          lastTradeTime: 0,
          lastUpdateTime: Date.now()
        };
        
        await this.saveTraderStats(traderAddress, initialStats);
        return initialStats;
      }
      
      // 解析统计数据
      const stats: TraderStats = {
        totalTrades: parseInt(rawStats.totalTrades || '0'),
        totalVolume: parseFloat(rawStats.totalVolume || '0'),
        monitoringStartTime: parseInt(rawStats.monitoringStartTime || Date.now().toString()),
        totalClosedPositions: parseInt(rawStats.totalClosedPositions || '0'),
        profitablePositions: parseInt(rawStats.profitablePositions || '0'),
        winRate: parseFloat(rawStats.winRate || '0'),
        totalRealizedPnL: parseFloat(rawStats.totalRealizedPnL || '0'),
        largestWin: parseFloat(rawStats.largestWin || '0'),
        largestLoss: parseFloat(rawStats.largestLoss || '0'),
        lastTradeTime: parseInt(rawStats.lastTradeTime || '0'),
        lastUpdateTime: parseInt(rawStats.lastUpdateTime || Date.now().toString())
      };
      
      return stats;
      
    } catch (error) {
      logger.error(`📊 获取${traderAddress}统计失败:`, error);
      // 返回默认统计
      return {
        totalTrades: 0,
        totalVolume: 0,
        monitoringStartTime: Date.now(),
        totalClosedPositions: 0,
        profitablePositions: 0,
        winRate: 0,
        totalRealizedPnL: 0,
        largestWin: 0,
        largestLoss: 0,
        lastTradeTime: 0,
        lastUpdateTime: Date.now()
      };
    }
  }

  /**
   * 保存交易员统计数据
   */
  async saveTraderStats(traderAddress: string, stats: TraderStats): Promise<void> {
    try {
      const statsKey = `${this.STATS_KEY_PREFIX}${traderAddress}`;
      
      // 重新计算胜率
      stats.winRate = stats.totalClosedPositions > 0 
        ? stats.profitablePositions / stats.totalClosedPositions 
        : 0;
      
      stats.lastUpdateTime = Date.now();
      
      await this.redis.hSet(statsKey, {
        totalTrades: stats.totalTrades.toString(),
        totalVolume: stats.totalVolume.toString(),
        monitoringStartTime: stats.monitoringStartTime.toString(),
        totalClosedPositions: stats.totalClosedPositions.toString(),
        profitablePositions: stats.profitablePositions.toString(),
        winRate: stats.winRate.toString(),
        totalRealizedPnL: stats.totalRealizedPnL.toString(),
        largestWin: stats.largestWin.toString(),
        largestLoss: stats.largestLoss.toString(),
        lastTradeTime: stats.lastTradeTime.toString(),
        lastUpdateTime: stats.lastUpdateTime.toString()
      });
      
    } catch (error) {
      logger.error(`📊 保存${traderAddress}统计失败:`, error);
    }
  }

  /**
   * 记录新交易
   */
  async recordTrade(
    traderAddress: string, 
    asset: string, 
    notionalValue: number, 
    tradeType: 'open' | 'close' | 'increase' | 'decrease',
    realizedPnL?: number
  ): Promise<void> {
    try {
      const stats = await this.getTraderStats(traderAddress);
      
      // 更新基础统计
      stats.totalTrades += 1;
      stats.totalVolume += Math.abs(notionalValue);
      stats.lastTradeTime = Date.now();
      
      // 处理平仓统计
      if (tradeType === 'close' && realizedPnL !== undefined) {
        stats.totalClosedPositions += 1;
        stats.totalRealizedPnL += realizedPnL;
        
        if (realizedPnL > 0) {
          stats.profitablePositions += 1;
          stats.largestWin = Math.max(stats.largestWin, realizedPnL);
        } else if (realizedPnL < 0) {
          stats.largestLoss = Math.min(stats.largestLoss, realizedPnL); // 负数，所以用Math.min
        }
      }
      
      await this.saveTraderStats(traderAddress, stats);
      
      logger.debug(`📊 记录${traderAddress}交易`, {
        asset,
        tradeType,
        notionalValue,
        realizedPnL,
        totalTrades: stats.totalTrades,
        winRate: `${(stats.winRate * 100).toFixed(1)}%`
      });
      
    } catch (error) {
      logger.error(`📊 记录${traderAddress}交易失败:`, error);
    }
  }

  /**
   * 记录持仓信息
   */
  async recordPosition(
    traderAddress: string, 
    asset: string, 
    position: PositionInfo
  ): Promise<void> {
    try {
      const positionKey = `${this.POSITION_KEY_PREFIX}${traderAddress}:${asset}`;
      
      await this.redis.hSet(positionKey, {
        asset: position.asset,
        size: position.size.toString(),
        entryPrice: position.entryPrice.toString(),
        totalNotional: position.totalNotional.toString(),
        openTime: position.openTime.toString(),
        unrealizedPnL: (position.unrealizedPnL || 0).toString()
      });
      
      // 设置过期时间：7天
      await this.redis.expire(positionKey, 7 * 24 * 60 * 60);
      
    } catch (error) {
      logger.error(`📊 记录${traderAddress}持仓失败:`, error);
    }
  }

  /**
   * 获取持仓信息
   */
  async getPosition(traderAddress: string, asset: string): Promise<PositionInfo | null> {
    try {
      const positionKey = `${this.POSITION_KEY_PREFIX}${traderAddress}:${asset}`;
      const rawPosition = await this.redis.hGetAll(positionKey);
      
      if (!rawPosition || Object.keys(rawPosition).length === 0) {
        return null;
      }
      
      return {
        asset: rawPosition.asset,
        size: parseFloat(rawPosition.size),
        entryPrice: parseFloat(rawPosition.entryPrice),
        totalNotional: parseFloat(rawPosition.totalNotional),
        openTime: parseInt(rawPosition.openTime),
        unrealizedPnL: parseFloat(rawPosition.unrealizedPnL || '0')
      };
      
    } catch (error) {
      logger.error(`📊 获取${traderAddress}持仓失败:`, error);
      return null;
    }
  }

  /**
   * 获取监控时长（天数）
   */
  getMonitoringDays(monitoringStartTime: number): number {
    const now = Date.now();
    const diffMs = now - monitoringStartTime;
    return Math.max(1, Math.floor(diffMs / (24 * 60 * 60 * 1000)));
  }

  /**
   * 格式化统计数据用于显示
   */
  formatStatsForDisplay(stats: TraderStats): {
    totalTrades: string;
    winRate: string;
    totalRealizedPnL: string;
    totalVolume: string;
    monitoringDays: string;
    performance: string;
  } {
    const monitoringDays = this.getMonitoringDays(stats.monitoringStartTime);
    const winRatePercent = (stats.winRate * 100).toFixed(1);
    
    const formatCurrency = (amount: number) => {
      if (Math.abs(amount) >= 1000000) {
        return `$${(amount / 1000000).toFixed(2)}M`;
      } else if (Math.abs(amount) >= 1000) {
        return `$${(amount / 1000).toFixed(1)}K`;
      } else {
        return `$${amount.toFixed(2)}`;
      }
    };

    const performance = stats.totalRealizedPnL >= 0 ? '🟢 Profitable' : '🔴 Losing';
    
    return {
      totalTrades: stats.totalTrades.toString(),
      winRate: `${winRatePercent}%`,
      totalRealizedPnL: formatCurrency(stats.totalRealizedPnL),
      totalVolume: formatCurrency(stats.totalVolume),
      monitoringDays: `${monitoringDays}d`,
      performance
    };
  }

  /**
   * 获取所有交易员统计概览
   */
  async getAllTradersStats(): Promise<Map<string, TraderStats>> {
    const allStats = new Map<string, TraderStats>();
    
    try {
      const pattern = `${this.STATS_KEY_PREFIX}*`;
      const keys = await this.redis.keys(pattern);
      
      for (const key of keys) {
        const address = key.replace(this.STATS_KEY_PREFIX, '');
        const stats = await this.getTraderStats(address);
        allStats.set(address, stats);
      }
      
    } catch (error) {
      logger.error('📊 获取所有交易员统计失败:', error);
    }
    
    return allStats;
  }
}

export default TraderStatsService;
