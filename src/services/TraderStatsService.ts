import { createClient, RedisClientType } from 'redis';
import config from '../config';
import logger from '../logger';
import { ContractTrader } from '../types';

export interface TraderStats {
  // 基础统计（7天窗口）
  totalTrades: number;           // 7天内交易次数
  totalVolume: number;           // 7天内交易量(USD) - 将被移除
  weeklyStartTime: number;       // 7天窗口开始时间
  
  // 胜率统计（7天窗口）
  totalClosedPositions: number;  // 7天内平仓次数
  profitablePositions: number;   // 7天内盈利平仓次数
  winRate: number;              // 胜率 = profitablePositions / totalClosedPositions
  
  // 盈亏统计（7天窗口）
  totalRealizedPnL: number;     // 7天内已实现盈亏
  largestWin: number;           // 7天内最大单笔盈利
  largestLoss: number;          // 7天内最大单笔亏损
  
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
  private readonly TRADES_KEY_PREFIX = 'trader_trades:'; // 新增：存储交易记录
  private readonly POSITION_KEY_PREFIX = 'trader_positions:'; // 保留兼容性
  private readonly WEEKLY_WINDOW_DAYS = 7; // 7天窗口
  
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
   * 获取7天内的交易记录
   */
  private async getWeeklyTrades(traderAddress: string, startTime: number, endTime: number): Promise<any[]> {
    try {
      const tradesKey = `${this.TRADES_KEY_PREFIX}${traderAddress}`;
      const allTrades = await this.redis.lRange(tradesKey, 0, -1);
      
      return allTrades
        .map(trade => JSON.parse(trade))
        .filter(trade => trade.timestamp >= startTime && trade.timestamp <= endTime);
      
    } catch (error) {
      logger.error(`获取${traderAddress}7天交易记录失败:`, error);
      return [];
    }
  }

  /**
   * 计算7天统计数据
   */
  private calculateWeeklyStats(trades: any[], weeklyStartTime: number): TraderStats {
    const stats: TraderStats = {
      totalTrades: trades.length,
      totalVolume: 0, // 将被移除
      weeklyStartTime,
      totalClosedPositions: 0,
      profitablePositions: 0,
      winRate: 0,
      totalRealizedPnL: 0,
      largestWin: 0,
      largestLoss: 0,
      lastTradeTime: 0,
      lastUpdateTime: Date.now()
    };

    for (const trade of trades) {
      // 更新交易量
      stats.totalVolume += Math.abs(trade.notionalValue || 0);
      
      // 更新最后交易时间
      if (trade.timestamp > stats.lastTradeTime) {
        stats.lastTradeTime = trade.timestamp;
      }
      
      // 处理平仓统计
      if (trade.tradeType === 'close') {
        stats.totalClosedPositions += 1;
        
        const pnl = trade.realizedPnL || 0;
        stats.totalRealizedPnL += pnl;
        
        if (pnl > 0) {
          stats.profitablePositions += 1;
          stats.largestWin = Math.max(stats.largestWin, pnl);
        } else if (pnl < 0) {
          stats.largestLoss = Math.min(stats.largestLoss, pnl);
        }
      }
    }
    
    // 计算胜率
    stats.winRate = stats.totalClosedPositions > 0 
      ? stats.profitablePositions / stats.totalClosedPositions 
      : 0;
    
    return stats;
  }

  /**
   * 获取默认统计数据
   */
  private getDefaultStats(): TraderStats {
    const now = Date.now();
    return {
      totalTrades: 0,
      totalVolume: 0,
      weeklyStartTime: now - (this.WEEKLY_WINDOW_DAYS * 24 * 60 * 60 * 1000),
      totalClosedPositions: 0,
      profitablePositions: 0,
      winRate: 0,
      totalRealizedPnL: 0,
      largestWin: 0,
      largestLoss: 0,
      lastTradeTime: 0,
      lastUpdateTime: now
    };
  }

  /**
   * 获取交易员7天统计数据
   */
  async getTraderStats(traderAddress: string): Promise<TraderStats> {
    try {
      const now = Date.now();
      const weekAgo = now - (this.WEEKLY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      
      // 获取7天内的交易记录
      const weeklyTrades = await this.getWeeklyTrades(traderAddress, weekAgo, now);
      
      // 计算7天统计
      const stats = this.calculateWeeklyStats(weeklyTrades, weekAgo);
      
      logger.debug(`📊 计算${traderAddress.slice(0,6)}...7天统计`, {
        totalTrades: stats.totalTrades,
        totalClosedPositions: stats.totalClosedPositions,
        profitablePositions: stats.profitablePositions,
        winRate: `${(stats.winRate * 100).toFixed(1)}%`,
        totalRealizedPnL: stats.totalRealizedPnL.toFixed(2)
      });
      
      return stats;
      
    } catch (error) {
      logger.error(`📊 获取${traderAddress}统计失败:`, error);
      // 返回默认统计
      return this.getDefaultStats();
    }
  }
  /**
   * 记录持仓信息 - 保留用于开仓记录
   */
  async recordPosition(
    traderAddress: string, 
    asset: string, 
    position: PositionInfo
  ): Promise<void> {
    try {
      // 简化：只记录最新的持仓信息，用于分析
      const positionKey = `trader_position:${traderAddress}:${asset}`;
      
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
   * 记录新交易 - 改为存储交易记录
   */
  async recordTrade(
    traderAddress: string, 
    asset: string, 
    notionalValue: number, 
    tradeType: 'open' | 'close' | 'increase' | 'decrease',
    realizedPnL?: number
  ): Promise<void> {
    try {
      // 🔧 新逻辑：存储交易记录而不是累计统计
      const tradeRecord = {
        timestamp: Date.now(),
        asset,
        tradeType,
        notionalValue,
        realizedPnL: realizedPnL || 0,
        // 用于调试
        debug: {
          hasRealizedPnL: realizedPnL !== undefined,
          originalRealizedPnL: realizedPnL
        }
      };

      const tradesKey = `${this.TRADES_KEY_PREFIX}${traderAddress}`;
      
      // 存储交易记录
      await this.redis.lPush(tradesKey, JSON.stringify(tradeRecord));
      
      // 设置过期时间：保留14天的记录（7天窗口 + 7天历史）
      await this.redis.expire(tradesKey, 14 * 24 * 60 * 60);
      
      // 🔧 添加详细调试日志
      logger.info(`📊 [调试] 记录交易到7天窗口`, {
        traderAddress: traderAddress.slice(0, 6) + '...' + traderAddress.slice(-4),
        asset,
        tradeType,
        notionalValue: notionalValue.toFixed(2),
        realizedPnL: realizedPnL?.toFixed(2) || 'undefined',
        hasRealizedPnL: realizedPnL !== undefined,
        isClose: tradeType === 'close'
      });
      
      // 如果是平仓，额外记录调试信息
      if (tradeType === 'close') {
        logger.info(`💰 [调试] 平仓交易记录`, {
          traderAddress: traderAddress.slice(0, 6) + '...' + traderAddress.slice(-4),
          asset,
          realizedPnL: realizedPnL?.toFixed(2) || '0.00',
          willCountTowardStats: true
        });
      }
      
    } catch (error) {
      logger.error(`📊 记录${traderAddress}交易失败:`, error);
    }
  }

  /**
   * 获取监控天数（改为7天窗口显示）
   */
  getMonitoringDays(): number {
    return this.WEEKLY_WINDOW_DAYS; // 固定返回7天
  }

  /**
   * 格式化统计数据用于显示 - 移除交易量字段
   */
  formatStatsForDisplay(stats: TraderStats): {
    totalTrades: string;
    winRate: string;
    totalRealizedPnL: string;
    monitoringDays: string;
    performance: string;
  } {
    const monitoringDays = this.getMonitoringDays();
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

    const performance = stats.totalClosedPositions === 0 
      ? '📊 评估中' 
      : stats.totalRealizedPnL > 0 
        ? '🟢 Profitable' 
        : stats.totalRealizedPnL < 0 
          ? '🔴 Losing'
          : '⚪ 盈亏平衡';
    
    return {
      totalTrades: stats.totalTrades.toString(),
      winRate: `${winRatePercent}%`,
      totalRealizedPnL: formatCurrency(stats.totalRealizedPnL),
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
