# HYPE解锁与合约监控系统

实时监控Hyperliquid上的HYPE代币解锁转账和合约交易信号，通过Webhook提供毫秒级预警。

## ✨ 主要功能

### 🔄 转账监控
- **实时监控**: 26个指定钱包地址的HYPE代币转入/转出操作
- **智能预警**: 单笔≥10,000 HYPE 和 24小时累计≥50,000 HYPE
- **去重处理**: 24小时窗口内避免重复警报

### 📊 合约交易监控 (NEW!)
- **多种监控模式**: WebSocket实时监控 + RPC轮询监控
- **交易员跟踪**: 监控指定交易员的合约开仓/平仓信号  
- **智能聚合**: RPC模式自动聚合大订单子成交，避免重复警报
- **地址验证**: 严格验证交易员地址，避免误报
- **多空识别**: 自动识别开多、开空、平仓操作
- **价值筛选**: 支持最小名义价值阈值过滤
- **资产过滤**: 可配置监控特定资产（BTC、ETH等）

### 🔔 通知系统
- **双Webhook支持**: 转账监控和合约监控使用独立Webhook
- **重试机制**: 支持重试的实时通知
- **详细格式化**: 结构化的警报消息格式

### 🛠 技术特性
- **Redis缓存**: 高效的数据缓存和统计
- **容错设计**: 自动重连和错误恢复
- **并行监控**: 转账与合约监控同时工作

## 📁 项目结构

```
hyper-unstaking-monitor/
├── src/
│   ├── engine/
│   │   └── alert-engine.ts      # 预警引擎
│   ├── services/
│   │   ├── hyperliquid-monitor.ts # Hyperliquid WebSocket监控
│   │   ├── webSocketContractMonitor.ts # WebSocket合约监控
│   │   ├── pooledWebSocketContractMonitor.ts # 连接池WebSocket监控
│   │   ├── robustWebSocketContractMonitor.ts # 稳健WebSocket监控
│   │   └── rpcContractMonitor.ts # RPC轮询合约监控 (推荐)
│   ├── utils/
│   │   └── helpers.ts           # 工具函数
│   ├── cache.ts                 # Redis缓存管理
│   ├── config.ts                # 配置管理
│   ├── logger.ts                # 日志系统
│   ├── types.ts                 # TypeScript类型定义
│   ├── webhook.ts               # Webhook通知 (支持双Webhook)
│   └── index.ts                 # 主程序入口
├── tests/                       # 测试文件
│   └── contractMonitor.test.ts  # 合约监控测试
├── logs/                        # 日志文件目录
├── docker-compose.yml           # Redis容器配置
├── package.json
├── tsconfig.json
└── README.md
```

## 🚀 快速开始

> 💡 **新用户推荐**：查看 [快速启动指南](./quick-start.md) 获取详细的一键启动教程  
> 🌥️ **云端部署**：如遇端口冲突或npm问题，查看 [云端部署指南](./CLOUD-DEPLOY.md)

### 方法一：一键快速启动 (推荐)

```bash
# 1. 配置环境变量
cp .env.example .env
# 编辑 .env 文件，配置Webhook URL等参数

# 2. 一键启动 (自动完成：安装依赖 → 构建 → Docker打包 → 启动)
./manage.sh quick

# 3. 查看日志
./manage.sh logs

# 4. 查看状态
./manage.sh status
```

### 方法二：传统启动方式

#### 1. 安装依赖
```bash
# 使用 pnpm (推荐)
pnpm install

# 或使用 npm
npm install
```

#### 2. 构建项目
```bash
# 使用 pnpm (推荐)
pnpm build

# 或使用 npm
npm run build
```

#### 3. Docker 启动
```bash
# 构建 Docker 镜像
docker-compose build hype-monitor

# 启动服务
docker-compose up -d hype-monitor

# 查看日志
docker-compose logs -f hype-monitor
```

### 方法三：开发模式

```bash
# 1. 安装依赖
npm install

# 2. 启动Redis服务
npm run docker:up

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env 文件

# 4. 启动开发模式
npm run dev
```

## ⚙️ 配置说明

### 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `WEBHOOK_URL` | 转账监控Webhook通知地址 | - |
| `CONTRACT_WEBHOOK_URL` | 合约监控Webhook通知地址 | - |
| `REDIS_URL` | Redis连接地址 | `redis://localhost:6379` |
| `SINGLE_TRANSFER_THRESHOLD` | 单笔转账预警阈值 | `10000` |
| `DAILY_CUMULATIVE_THRESHOLD` | 24小时累计预警阈值 | `50000` |
| `CONTRACT_MONITORING_ENABLED` | 是否启用合约监控 | `false` |
| `CONTRACT_MIN_NOTIONAL` | 合约监控最小名义价值 | `1000` |
| `CONTRACT_ASSETS` | 监控的资产列表(逗号分隔) | 全部资产 |
| `CONTRACT_MONITOR_TYPE` | 合约监控器类型 | `rpc` |
| `LOG_LEVEL` | 日志级别 | `info` |

### 合约监控器类型

| 类型 | 说明 | 优势 | 适用场景 |
|------|------|------|---------|
| `rpc` | RPC轮询监控器 | 稳定性高，智能聚合订单，避免重复警报 | **推荐** - 生产环境 |
| `robust` | 稳健WebSocket监控器 | 实时性好，连接稳定性优化 | 对实时性要求高的场景 |
| `pooled` | 连接池WebSocket监控器 | 支持更多交易员，资源利用率高 | 监控大量交易员 |
| `single` | 单连接WebSocket监控器 | 简单易用，资源消耗低 | 监控少量交易员 |

### 监控地址

#### 转账监控
系统监控26个预设地址，包括：
- 主要解锁地址 (2,381,375.14 HYPE)
- 25个其他解锁地址
- 支持自定义预警阈值

#### 合约监控 (NEW!)
监控4个指定交易员地址：
- 0xfa6af5f4f7440ce389a1e650991eea45c161e13e
- 0xa04a4b7b7c37dbd271fdc57618e9cb9836b250bf  
- 0xb8b9e3097c8b1dddf9c5ea9d48a7ebeaf09d67d2
- 0xd5ff5491f6f3c80438e02c281726757baf4d1070

## 📊 预警规则

### 1. 转账预警
#### 单笔转账预警
- **条件**: 单笔转入/转出 ≥ 10,000 HYPE
- **通知**: 立即发送到转账Webhook

#### 24小时累计预警
- **条件**: 24小时累计转入/转出 ≥ 50,000 HYPE  
- **通知**: 立即发送到转账Webhook

### 2. 合约交易预警 (NEW!)
#### 开仓信号
- **条件**: 监控地址开多仓/开空仓
- **过滤**: 名义价值 ≥ $1,000
- **通知**: 立即发送到合约Webhook

#### 平仓信号
- **条件**: 监控地址平仓操作
- **过滤**: 名义价值 ≥ $1,000  
- **通知**: 立即发送到合约Webhook

### 2. 累计转账预警
- **条件**: 24小时累计转入/转出 ≥ 50,000 HYPE
- **通知**: 立即发送Webhook
- **重置**: 每日UTC 00:00自动重置

## 📡 Webhook通知格式

```json
{
  "timestamp": 1672531200000,
  "alertType": "single_transfer_in",
  "address": "0x5d83bb3313240cab65e2e9200d3aaf3520474fb6",
  "addressLabel": "主要解锁地址",
  "amount": "25000",
  "txHash": "0xabc123...",
  "blockTime": 1672531180000,
  "unlockAmount": 2381375.14,
  "cumulativeToday": "75000"
}
```

### 预警类型
- `single_transfer_in`: 单笔转入预警
- `single_transfer_out`: 单笔转出预警
- `cumulative_transfer_in`: 累计转入预警
- `cumulative_transfer_out`: 累计转出预警

## 🛠 开发和维护

### 管理脚本使用

#### 🚀 快速命令
```bash
./manage.sh quick          # 一键快速启动 (推荐)
./manage.sh logs           # 查看实时日志
./manage.sh status         # 查看服务状态
./manage.sh stop           # 停止服务
./manage.sh restart        # 重启服务
```

#### 🐳 Docker 命令
```bash
./manage.sh docker:build   # 构建Docker镜像
./manage.sh docker:up      # 启动Docker服务
./manage.sh docker:down    # 停止Docker服务
./manage.sh docker:restart # 重启Docker服务
./manage.sh docker:logs    # 查看Docker日志
./manage.sh docker:status  # 查看Docker状态
./manage.sh docker:clean   # 清理Docker资源
```

#### ⚙️ 传统命令
```bash
./manage.sh dev            # 启动开发环境
./manage.sh build          # 构建项目
./manage.sh install        # 安装依赖
./manage.sh deploy         # 部署应用
./manage.sh clean          # 清理构建文件
```

### npm 脚本命令
```bash
npm run dev          # 开发模式启动
npm run build        # 构建生产版本
npm start            # 生产模式启动
npm run docker:up    # 启动Redis容器
npm run docker:down  # 停止Redis容器
npm run docker:logs  # 查看容器日志
```

### 日志监控
```bash
# 实时查看日志
tail -f logs/hype-monitor.log

# 查看Docker容器日志
npm run docker:logs
```

### 系统状态
系统每5分钟输出状态报告，包括：
- 运行时长
- WebSocket连接状态
- 订阅数量
- 监控地址数量
- 活跃规则数量

## 🔧 技术栈

- **语言**: TypeScript/Node.js
- **WebSocket**: @nktkas/hyperliquid
- **缓存**: Redis 7
- **通知**: Axios HTTP请求
- **日志**: Winston
- **容器**: Docker Compose

## 🚨 故障排除

### 常见问题

1. **WebSocket连接失败**
   - 检查网络连接
   - 确认Hyperliquid API可访问
   - 查看日志中的连接错误信息

2. **Redis连接失败**
   ```bash
   # 检查Redis容器状态
   docker ps
   
   # 重启Redis
   npm run docker:down && npm run docker:up
   ```

3. **Webhook发送失败**
   - 验证Webhook URL配置
   - 检查网络连接
   - 查看重试日志

4. **内存使用过高**
   - 检查Redis缓存大小
   - 监控WebSocket连接数量
   - 考虑调整日志级别

### 性能优化

- **监控延迟**: 系统设计目标 <1秒响应时间
- **WebSocket管理**: 自动重连和订阅恢复
- **缓存策略**: 25小时TTL自动清理
- **错误处理**: 完整的异常捕获和恢复

## 📈 监控指标

系统提供以下监控指标：
- WebSocket连接状态
- 订阅数量
- 处理的事件数量
- 缓存命中率
- Webhook成功率
- 系统运行时长

## 🔒 安全考虑

- 所有敏感配置通过环境变量管理
- Redis连接使用密码保护（生产环境）
- Webhook请求包含系统标识
- 完整的错误日志记录

## 📞 支持

如有问题或建议，请联系开发团队或查看项目日志获取详细错误信息。