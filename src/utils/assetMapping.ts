/**
 * Hyperliquid资产映射工具
 * 用于将@index格式的资产ID映射为可读的代币名称
 */

export interface AssetMapping {
  [key: string]: string;
}

// 已知的Hyperliquid资产映射
export const KNOWN_ASSET_MAPPING: AssetMapping = {
  // 官方确认的映射
  '@107': 'HYPE',  // HYPE token (token index 150, spot pair @107)
  '@0': 'PURR',    // PURR/USDC pair index 0
  
  // 基于社区反馈和链上数据的映射
  '@1': 'HFUN',
  '@2': 'DEGEN',
  '@3': 'PEPE',
  '@4': 'WOJAK',
  '@5': 'MEME',
  
  // 常见DeFi代币
  '@10': 'USDT',
  '@11': 'USDC',
  '@12': 'WETH',
  '@13': 'WBTC',
  
  // 从日志中观察到的资产
  '@151': 'SPOT_151',  // 观察到有交易活动
  '@188': 'PUMP',      // PUMP代币现货交易对
  '@162': 'SPOT_162',  // HYPE相关交易对
  '@192': 'SPOT_192',  // 观察到大额交易
  '@193': 'SPOT_193',
  '@204': 'SPOT_204',
  '@254': 'SPOT_254',
  
  // 永续合约资产（直接使用名称）
  'BTC': 'BTC',
  'ETH': 'ETH', 
  'SOL': 'SOL',
  'AVAX': 'AVAX',
  'MATIC': 'MATIC',
  'BNB': 'BNB',
  'ADA': 'ADA',
  'DOGE': 'DOGE',
  'XRP': 'XRP',
  'DOT': 'DOT',
  'LINK': 'LINK',
  'UNI': 'UNI',
  'LTC': 'LTC',
  'ATOM': 'ATOM',
  'FIL': 'FIL',
  'NEAR': 'NEAR',
  'SUI': 'SUI',
  'APT': 'APT',
  'TAO': 'TAO',
  'RNDR': 'RNDR',
  'ONDO': 'ONDO',
  'FTM': 'FTM',
  'ICP': 'ICP',
  'HBAR': 'HBAR'
};

/**
 * 资产映射管理器
 */
export class AssetMappingManager {
  private mapping: AssetMapping;
  private unknownAssets = new Set<string>();

  constructor(initialMapping: AssetMapping = KNOWN_ASSET_MAPPING) {
    this.mapping = { ...initialMapping };
  }

  /**
   * 获取资产的显示名称
   */
  getDisplayName(asset: string): string {
    // 检查是否已有映射
    if (this.mapping[asset]) {
      return this.mapping[asset];
    }

    // 如果是@开头的资产但没有映射，记录为未知资产
    if (asset.startsWith('@')) {
      this.unknownAssets.add(asset);
      // 返回格式化的未知资产名称
      return `SPOT_${asset.substring(1)}`;
    }

    // 永续合约资产直接返回
    return asset;
  }

  /**
   * 添加新的资产映射
   */
  addMapping(asset: string, name: string): void {
    this.mapping[asset] = name;
    this.unknownAssets.delete(asset);
  }

  /**
   * 批量添加映射
   */
  addMappings(mappings: AssetMapping): void {
    Object.assign(this.mapping, mappings);
    // 清理已知的未知资产
    Object.keys(mappings).forEach(asset => {
      this.unknownAssets.delete(asset);
    });
  }

  /**
   * 从API更新资产映射
   */
  async updateFromAPI(spotMeta: any): Promise<number> {
    let newMappings = 0;

    if (spotMeta && spotMeta.universe) {
      for (let i = 0; i < spotMeta.universe.length; i++) {
        const spotAsset = spotMeta.universe[i];
        if (spotAsset && spotAsset.tokens && spotAsset.tokens.length > 0) {
          const indexKey = `@${i}`;
          
          // 如果还没有映射，创建一个
          if (!this.mapping[indexKey]) {
            // 尝试从tokens数组中获取有意义的名称
            const tokenName = this.extractTokenName(spotAsset, i);
            this.addMapping(indexKey, tokenName);
            newMappings++;
          }
        }
      }
    }

    return newMappings;
  }

  private extractTokenName(spotAsset: any, index: number): string {
    // 尝试从spotAsset中提取有意义的名称
    if (spotAsset.name && typeof spotAsset.name === 'string') {
      return spotAsset.name.toUpperCase();
    }

    if (spotAsset.tokens && spotAsset.tokens.length > 0) {
      // 如果是与USDC的交易对，尝试获取第一个token的信息
      if (spotAsset.tokens.includes(0)) { // 0通常是USDC
        const otherToken = spotAsset.tokens.find((t: number) => t !== 0);
        if (otherToken) {
          return `TOKEN_${otherToken}`;
        }
      }
    }

    // 默认使用索引
    return `SPOT_${index}`;
  }

  /**
   * 获取所有未知资产
   */
  getUnknownAssets(): string[] {
    return Array.from(this.unknownAssets);
  }

  /**
   * 获取所有映射
   */
  getAllMappings(): AssetMapping {
    return { ...this.mapping };
  }

  /**
   * 检查是否为已知资产
   */
  isKnownAsset(asset: string): boolean {
    return asset in this.mapping;
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      totalMappings: Object.keys(this.mapping).length,
      unknownAssets: this.unknownAssets.size,
      spotAssets: Object.keys(this.mapping).filter(k => k.startsWith('@')).length,
      perpAssets: Object.keys(this.mapping).filter(k => !k.startsWith('@')).length
    };
  }

  /**
   * 导出未知资产建议
   */
  generateMappingSuggestions(): string[] {
    return Array.from(this.unknownAssets).map(asset => 
      `'${asset}': 'TOKEN_NAME', // 请手动填写正确的代币名称`
    );
  }
}

// 全局资产映射管理器实例
export const assetMapper = new AssetMappingManager();
