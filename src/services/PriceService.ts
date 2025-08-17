import * as hl from '@nktkas/hyperliquid';
import logger from '../logger';

export interface TokenPrice {
  symbol: string;
  price: number;
  timestamp: number;
}

export class PriceService {
  private infoClient: hl.InfoClient;
  private priceCache = new Map<string, TokenPrice>();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存
  private lastUpdateTime = 0;
  
  constructor() {
    const transport = new hl.HttpTransport({
      timeout: 10000,
      isTestnet: false
    });
    this.infoClient = new hl.InfoClient({ transport });
    
    logger.info('💰 价格服务初始化完成', {
      cacheTTL: `${this.CACHE_TTL / 1000}s`,
      strategy: 'Hyperliquid AllMids + 缓存'
    });
  }

  /**
   * 获取代币价格
   */
  async getTokenPrice(symbol: string): Promise<number | null> {
    try {
      // 检查缓存
      const cached = this.priceCache.get(symbol.toUpperCase());
      const now = Date.now();
      
      if (cached && (now - cached.timestamp) < this.CACHE_TTL) {
        logger.debug(`💰 使用缓存价格`, { symbol, price: cached.price });
        return cached.price;
      }

      // 获取所有价格（批量更新缓存）
      await this.updateAllPrices();
      
      // 从更新后的缓存获取
      const updated = this.priceCache.get(symbol.toUpperCase());
      return updated ? updated.price : null;

    } catch (error) {
      logger.error(`💰 获取${symbol}价格失败:`, error);
      return null;
    }
  }

  /**
   * 批量更新所有价格
   */
  private async updateAllPrices(): Promise<void> {
    const now = Date.now();
    
    // 避免频繁更新
    if (now - this.lastUpdateTime < 30000) { // 30秒内不重复更新
      return;
    }

    try {
      logger.debug('💰 开始批量更新价格...');
      
      const allMids = await this.infoClient.allMids();
      
      if (!allMids) {
        logger.warn('💰 未获取到价格数据');
        return;
      }

      let updatedCount = 0;
      
      // 更新缓存
      for (const [symbol, priceStr] of Object.entries(allMids)) {
        const price = parseFloat(priceStr);
        if (!isNaN(price) && price > 0) {
          this.priceCache.set(symbol.toUpperCase(), {
            symbol: symbol.toUpperCase(),
            price,
            timestamp: now
          });
          updatedCount++;
        }
      }

      this.lastUpdateTime = now;
      
      logger.info(`💰 价格更新完成`, {
        updatedTokens: updatedCount,
        totalCached: this.priceCache.size,
        nextUpdate: new Date(now + 30000).toISOString()
      });

    } catch (error) {
      logger.error('💰 批量更新价格失败:', error);
    }
  }

  /**
   * 计算USD价值
   */
  async calculateUsdValue(amount: string, symbol: string): Promise<{
    price: number | null;
    usdValue: number | null;
    formattedPrice: string;
    formattedValue: string;
  }> {
    const numAmount = parseFloat(amount);
    if (isNaN(numAmount)) {
      return {
        price: null,
        usdValue: null,
        formattedPrice: 'N/A',
        formattedValue: 'N/A'
      };
    }

    const price = await this.getTokenPrice(symbol);
    
    if (price === null) {
      return {
        price: null,
        usdValue: null,
        formattedPrice: 'Price N/A',
        formattedValue: 'Value N/A'
      };
    }

    const usdValue = numAmount * price;
    
    return {
      price,
      usdValue,
      formattedPrice: `$${price.toLocaleString('en-US', { 
        minimumFractionDigits: 2, 
        maximumFractionDigits: 4 
      })}`,
      formattedValue: `$${usdValue.toLocaleString('en-US', { 
        minimumFractionDigits: 2, 
        maximumFractionDigits: 2 
      })}`
    };
  }

  /**
   * 获取价格缓存统计
   */
  getStats() {
    return {
      cachedTokens: this.priceCache.size,
      lastUpdateTime: this.lastUpdateTime,
      cacheAge: Date.now() - this.lastUpdateTime,
      cached: Array.from(this.priceCache.values()).map(p => ({
        symbol: p.symbol,
        price: p.price,
        age: Date.now() - p.timestamp
      }))
    };
  }
}

export default PriceService;
