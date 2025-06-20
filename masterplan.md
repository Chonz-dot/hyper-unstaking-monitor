# HYPE转账监控系统需求文档

## 1. 项目概述

### 1.1 项目背景
监控26个指定钱包地址的HYPE代币转账活动，重点关注转入操作的实时监控，为交易决策提供及时预警。

### 1.2 项目目标
- 实时监控HYPE代币转入活动
- 提供毫秒级的预警响应
- 通过Webhook推送警报通知
- 轻量级设计，专注异常检测

## 2. 功能需求

### 2.1 核心功能

#### 2.1.1 实时监控
- **监控目标**：26个指定钱包地址
- **监控内容**：
  - HYPE代币转入操作
  - HYPE现货买入交易（@107资产）
  - 解质押到账操作

#### 2.1.2 预警规则
- **主要预警**：单笔转入 ≥ 10,000 HYPE
- **累计预警**：24小时累计转入 ≥ 50,000 HYPE

#### 2.1.3 通知系统
- **Webhook**：HTTP POST推送警报到指定端点

### 2.2 数据功能

#### 2.2.1 简单记录
- 当前监控状态
- 24小时累计转入缓存
- 基础运行日志

## 3. 技术需求

### 3.1 技术栈选择
- **语言**：TypeScript/Node.js
- **WebSocket库**：@nktkas/hyperliquid
- **缓存**：Redis（24小时累计数据）
- **通知**：Webhook HTTP请求

### 3.2 架构设计

#### 3.2.1 核心组件
```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   WebSocket     │    │   Alert Engine  │    │   Webhook       │
│   Connector     │───▶│   & Rules       │───▶│   Notifier      │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │
         ▼                       ▼
┌─────────────────┐    ┌─────────────────┐
│   Redis Cache   │    │   Log Service   │
│   (24h data)    │    │   (Basic)       │
└─────────────────┘    └─────────────────┘
```

#### 3.2.2 数据流
1. WebSocket连接监听26个地址
2. 实时接收转入相关事件
3. 规则引擎检查预警条件
4. 触发预警并发送Webhook
5. 缓存累计数据用于24小时统计

### 3.3 性能要求
- **延迟**：<1秒响应时间
- **可用性**：99.9%正常运行时间
- **并发**：同时处理26个WebSocket订阅
- **存储**：仅缓存24小时数据

## 4. 详细功能设计

### 4.1 监控地址管理

#### 4.1.1 地址配置
```typescript
interface WatchedAddress {
  address: string;          // 钱包地址
  label: string;           // 地址标签
  customThresholds?: {     // 自定义阈值
    singleTransfer: number;
    dailyTotal: number;
  };
  isActive: boolean;       // 是否启用监控
}
```

### 4.2 事件处理

#### 4.2.1 事件类型定义
```typescript
interface MonitorEvent {
  timestamp: number;
  address: string;
  eventType: 'transfer_in' | 'trade_buy' | 'unstake';
  amount: string;          // HYPE数量
  hash: string;           // 交易哈希
  blockTime: number;      // 区块时间
}
```

#### 4.2.2 处理流程
1. **事件接收**：WebSocket实时接收
2. **过滤转入**：只处理转入相关事件
3. **规则匹配**：检查预警条件
4. **去重处理**：避免重复警报
5. **Webhook发送**：推送警报

### 4.3 预警系统

#### 4.3.1 预警规则引擎
```typescript
interface AlertRule {
  type: 'single_transfer' | 'cumulative_transfer';
  threshold: number;
  timeWindow?: number;    // 累计规则的时间窗口
  enabled: boolean;
}
```

#### 2.3.2 预设规则
1. **单笔转入监控**
   - 条件：单笔转入/转出 ≥ 10,000 HYPE
   - 通知：Webhook

2. **累计转入监控**
   - 条件：24小时累计转入/转出 ≥ 50,000 HYPE
   - 通知：Webhook

### 4.4 通知系统

#### 4.4.1 Webhook通知
```typescript
interface WebhookAlert {
  timestamp: number;
  alertType: 'single_transfer' | 'cumulative_transfer';
  address: string;
  addressLabel?: string;
  amount: string;        // HYPE数量
  txHash: string;       // 交易哈希
  blockTime: number;    // 区块时间
  cumulativeToday?: string; // 今日累计（仅累计警报）
}
```

**Webhook格式**：
```json
{
  "timestamp": 1672531200000,
  "alertType": "single_transfer",
  "address": "0x5d...4fb6",
  "addressLabel": "主要解锁地址",
  "amount": "25000",
  "txHash": "0xabc...",
  "blockTime": 1672531180000
}
```

### 4.5 缓存设计

#### 4.5.1 Redis缓存结构
```typescript
// 24小时累计转入缓存
interface DailyCache {
  [address: string]: {
    totalInbound: string;  // 累计转入金额
    transactions: {
      amount: string;
      timestamp: number;
      txHash: string;
    }[];
    lastReset: number;     // 上次重置时间
  }
}
```

#### 4.5.2 缓存策略
- Redis缓存监控地址配置
- Redis缓存24小时转入累计数据
- Redis缓存去重信息（防止重复警报）
- 自动清理过期数据（25小时TTL）

## 5. 开发实现要点

### 5.1 核心实现模块

#### 5.1.1 WebSocket监控器
```typescript
class HYPEMonitor {
  private client: hl.EventClient;
  private watchedAddresses: WatchedAddress[];
  
  async startMonitoring(): Promise<void>;
  private handleTransferIn(data: any, address: string): Promise<void>;
  private checkAlertRules(event: MonitorEvent): Promise<void>;
}
```

#### 5.1.2 预警引擎
```typescript
class AlertEngine {
  private rules: AlertRule[];
  private redis: Redis;
  
  async processEvent(event: MonitorEvent): Promise<void>;
  private checkSingleTransfer(event: MonitorEvent): Promise<boolean>;
  private checkCumulativeTransfer(event: MonitorEvent): Promise<boolean>;
}
```

#### 5.1.3 Webhook通知
```typescript
class WebhookNotifier {
  private webhookUrl: string;
  
  async sendAlert(alert: WebhookAlert): Promise<void>;
  private retry(request: () => Promise<any>, maxRetries: number): Promise<any>;
}
```

### 5.2 配置文件
```typescript
interface Config {
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
    singleThreshold: number;   // 10000
    dailyThreshold: number;    // 50000
    addresses: WatchedAddress[];
  };
}
```