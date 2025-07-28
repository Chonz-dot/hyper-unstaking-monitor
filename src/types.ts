// 监控地址配置接口
export interface WatchedAddress {
  address: string;
  label: string;
  unlockAmount: number; // 解锁数量
  customThresholds?: {
    singleTransfer: number;
    cumulative24h: number;
  };
  isActive: boolean;
}

// 合约交易员配置接口
export interface ContractTrader {
  address: string;
  label: string;
  description?: string;
  isActive: boolean;
}

// 监控事件类型
export interface MonitorEvent {
  timestamp: number;
  address: string;
  eventType: 'transfer_in' | 'transfer_out' | 'trade_buy' | 'trade_sell' | 'unstake' | 'deposit' | 'withdraw' | 'internal_transfer_in' | 'internal_transfer_out';
  amount: string;
  hash: string;
  blockTime: number;
  asset?: string; // 资产类型，如"HYPE"
  metadata?: {
    [key: string]: any; // 额外的元数据
  };
}

// 合约交易事件类型（更新为包含实时标记）
export interface ContractEvent {
  timestamp: number;
  address: string;
  eventType: 'position_open_long' | 'position_open_short' | 'position_close' | 'position_increase' | 'position_decrease';
  asset: string; // 交易资产，如 'BTC', 'ETH'
  size: string; // 持仓大小
  price?: string; // 交易价格
  side: 'long' | 'short'; // 多空方向
  hash: string;
  blockTime: number;
  positionSizeAfter?: string; // 交易后的持仓大小
  metadata?: {
    leverage?: number;
    notionalValue?: string;
    isRealTime?: boolean; // 标记为实时数据
    source?: string; // 数据源标识
    originalAsset?: string; // 原始资产名称
    markPrice?: string; // 标记价格
    explorerUrl?: string; // 区块链浏览器链接
    isMerged?: boolean; // 是否为合并事件
    mergedCount?: number; // 合并的事件数量
    originalFillsCount?: number; // 原始成交记录数量
    [key: string]: any;
  };
}

// 新增：合约信号类型（基于设计方案）
export interface ContractSignal {
  timestamp: number;
  trader: ContractTrader;
  eventType: 'position_open_long' | 'position_open_short' | 'position_close';
  asset: string;
  size: string;
  price?: string;
  side: 'long' | 'short';
  hash: string;
  blockTime: number;
  notionalValue: string;
  isRealTime: true; // 标记为实时数据
}

// 预警规则
export interface AlertRule {
  type: 'single_transfer' | 'cumulative_transfer';
  threshold: number;
  timeWindow?: number; // 累计规则的时间窗口（小时）
  enabled: boolean;
}

// Webhook警报格式
export interface WebhookAlert {
  timestamp: number;
  alertType: 'single_transfer_in' | 'single_transfer_out' | 'cumulative_transfer_in' | 'cumulative_transfer_out';
  address: string;
  addressLabel?: string;
  amount: string;
  txHash: string;
  blockTime: number;
  cumulativeToday?: string; // 今日累计（仅累计警报）
  unlockAmount?: number; // 该地址的解锁数量
}

// 合约交易Webhook警报格式
export interface ContractWebhookAlert {
  timestamp: number;
  alertType: 'position_open_long' | 'position_open_short' | 'position_close' | 'position_update';
  address: string;
  traderLabel?: string;
  asset: string;
  size: string;
  price?: string;
  side: 'long' | 'short';
  txHash: string;
  blockTime: number;
  positionSizeAfter?: string;
  notionalValue?: string;
  leverage?: number;
  // 添加合并相关字段
  mergedCount?: number; // 合并的成交数量
  originalFillsCount?: number; // 原始成交记录数量
  isMerged?: boolean; // 是否为合并事件
}

// 24小时缓存结构
export interface DailyCache {
  [address: string]: {
    totalInbound: string;
    totalOutbound: string;
    transactions: {
      amount: string;
      timestamp: number;
      txHash: string;
      direction: 'in' | 'out';
    }[];
    lastReset: number;
  };
}

// 应用配置
export interface Config {
  hyperliquid: {
    wsUrl: string;
    reconnectAttempts: number;
    connectionTimeout: number;
    subscriptionTimeout: number;
    connectionDelay: number;
    keepAliveInterval: number;
    keepAliveTimeout: number;
    maxConsecutiveErrors: number;
    maxReconnectAttempts: number;
  };
  redis: {
    url: string;
    keyPrefix: string;
  };
  webhook: {
    transferUrl: string; // 转账监控webhook
    contractUrl?: string; // 合约监控webhook
    timeout: number;
    retries: number;
  };
  monitoring: {
    singleThreshold: number;
    cumulative24hThreshold: number;
    addresses: WatchedAddress[];
  };
  contractMonitoring: {
    enabled: boolean;
    traders: ContractTrader[];
    minNotionalValue?: number; // 最小名义价值阈值
    assets?: string[]; // 监控的资产列表，空则监控所有
  };
  logging: {
    level: string;
    file?: string;
  };
}
