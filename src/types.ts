// 监控地址配置接口
export interface WatchedAddress {
  address: string;
  label: string;
  unlockAmount: number; // 解锁数量
  customThresholds?: {
    singleTransfer: number;
    dailyTotal: number;
  };
  isActive: boolean;
}

// 监控事件类型
export interface MonitorEvent {
  timestamp: number;
  address: string;
  eventType: 'transfer_in' | 'transfer_out' | 'trade_buy' | 'unstake';
  amount: string;
  hash: string;
  blockTime: number;
  asset?: string; // 资产类型，如"HYPE"
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

// 日缓存结构
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
  };
  redis: {
    url: string;
    keyPrefix: string;
  };
  webhook: {
    url: string;
    timeout: number;
    retries: number;
  };
  monitoring: {
    singleThreshold: number;
    dailyThreshold: number;
    addresses: WatchedAddress[];
  };
  logging: {
    level: string;
    file?: string;
  };
}
