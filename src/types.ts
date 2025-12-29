// 监控地址配置
export interface WatchedAddress {
  address: string;          // 钱包地址
  label: string;           // 地址标签
  unlockAmount: number;    // 预计解锁数量
  isActive: boolean;       // 是否启用监控
  customThresholds?: {     // 自定义阈值
    singleTransfer: number;
    dailyTotal: number;
    cumulative24h?: number;
  };
}

// 合约交易员配置
export interface ContractTrader {
  address: string;         // 交易员地址
  label: string;          // 交易员标签
  description?: string;   // 描述
  webhook?: string;       // 自定义webhook URL（可选，未配置则使用全局webhook）
  isActive: boolean;      // 是否启用监控
}

// 监控事件接口
export interface MonitorEvent {
  timestamp: number;
  address: string;
  eventType: 'transfer_in' | 'transfer_out' | 'trade_buy' | 'deposit' | 'withdraw';
  amount: string;          // HYPE数量
  hash: string;           // 交易哈希
  blockTime: number;      // 区块时间
  asset?: string;         // 资产名称
  metadata?: {
    originalAsset?: string;
    source?: string;
    isRealTime?: boolean;
    price?: string;
    counterparty?: string;
    usdValue?: string;
    [key: string]: any;
  };
}

// 合约事件接口
export interface ContractEvent {
  timestamp: number;
  address: string;
  eventType: 'position_open_long' | 'position_open_short' | 'position_close' | 'position_increase' | 'position_decrease' | 'position_reverse' | 'no_change' | 'unknown';
  asset: string;
  size: string;
  price: string;
  side: 'long' | 'short';
  hash: string;
  blockTime: number;
  positionSizeAfter?: string;
  metadata?: {
    notionalValue?: string;
    leverage?: string;
    originalAsset?: string;
    source?: string;
    isRealTime?: boolean;
    markPrice?: string;
    rawEventTime?: number;
    isAggregated?: boolean;
    originalFillsCount?: number;
    aggregationTimespan?: number;
    [key: string]: any;
  };
}

// 警报规则配置
export interface AlertRule {
  id: string;
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
  metadata?: {
    originalAsset?: string;
    source?: string;
    addressLabel?: string;
    unlockAmount?: number;
    usdcValue?: string;
    transferType?: string;
    delta?: any;
    originalHash?: string;
    isInternalOperation?: boolean;
    [key: string]: any; // 允许其他字段
  };
  // 🆕 价格信息
  priceInfo?: {
    tokenPrice: number | null;
    usdValue: number | null;
    formattedPrice: string;
    formattedValue: string;
  };
  // 🆕 累计价格信息（仅累计警报）
  cumulativePriceInfo?: {
    usdValue: number | null;
    formattedValue: string;
  };
}

// 合约交易Webhook警报格式
export interface ContractWebhookAlert {
  timestamp: number;
  alertType: 'position_open_long' | 'position_open_short' | 'position_close' | 'position_update' | 'position_reverse';
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
  leverage?: string;
  mergedCount?: number;
  originalFillsCount?: number;
  isMerged?: boolean;
  // 🆕 交易员统计信息
  traderStats?: {
    totalTrades: string;      // 累计交易次数
    winRate: string;          // 胜率
    totalRealizedPnL: string; // 累计盈亏
    totalVolume: string;      // 累计交易量
    monitoringDays: string;   // 监控天数
    performance: string;      // 表现状态
  };
  // 🆕 当前开仓信息（仅开仓事件）
  positionInfo?: {
    totalNotional: string;    // 开仓总金额
    entryPrice: string;       // 成本价格
  };
  // 🆕 平仓盈亏信息（仅平仓事件）
  realizedPnL?: number;
}

// 缓存数据接口
export interface DailyCache {
  totalInbound: string;  // 累计转入金额
  totalOutbound: string; // 累计转出金额
  transactions: {
    amount: string;
    timestamp: number;
    txHash: string;
    type: 'in' | 'out';
  }[];
  lastReset: number;     // 上次重置时间
}

// 系统配置接口
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
    transferUrl: string;
    contractUrl?: string;
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
    monitorType?: 'single' | 'pooled' | 'robust' | 'rpc' | 'hybrid' | 'pure-rpc'; // 监控器类型
  };
  logging: {
    level: string;
    file?: string;
  };
}

// 监控状态
export interface MonitoringStatus {
  startTime: number;
  lastUpdate: number;
  totalAlerts?: number;
  errorCount?: number;
}

// 缓存数据接口
export interface CachedTransferData {
  totalInbound: string;  // 累计转入金额
  totalOutbound: string; // 累计转出金额
  transactions: {
    amount: string;
    timestamp: number;
    txHash: string;
    type: 'in' | 'out';
  }[];
  lastReset: number;     // 上次重置时间
}

// 统计数据接口
export interface AlertStats {
  totalAlerts: number;
  alertsByType: Record<string, number>;
  alertsByAddress: Record<string, number>;
  last24Hours: number;
}

// 导出所有类型
export type TransferDirection = 'in' | 'out';
export type AlertType = 'single_transfer_in' | 'single_transfer_out' | 'cumulative_transfer_in' | 'cumulative_transfer_out';
export type ContractEventType = 'position_open_long' | 'position_open_short' | 'position_close' | 'position_increase' | 'position_decrease';
export type MonitorType = 'single' | 'pooled' | 'robust' | 'rpc' | 'hybrid' | 'pure-rpc';
