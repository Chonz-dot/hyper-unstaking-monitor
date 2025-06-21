HYPE代币转入/转出操作
- **智能预警**: 单笔≥10,000 HYPE 和 24小时累计≥50,000 HYPE
- **去重处理**: 24小时窗口内避免重复警报
- **Webhook通知**: 支持重试机制的实时通知
- **Redis缓存**: 高效的数据缓存和统计
- **容错设计**: 自动重连和错误恢复

## 📁 项目结构

```
hyper-unstaking-monitor/
├── src/
│   ├── engine/
│   │   └── alert-engine.ts      # 预警引擎
│   ├── services/
│   │   └── hyperliquid-monitor.ts # Hyperliquid WebSocket监控
│   ├── utils/
│   │   └── helpers.ts           # 工具函数
│   ├── cache.ts                 # Redis缓存管理
│   ├── config.ts                # 配置管理
│   ├── logger.ts                # 日志系统
│   ├── types.ts                 # TypeScript类型定义
│   ├── webhook.ts               # Webhook通知
│   └── index.ts                 # 主程序入口
├── logs/                        # 日志文件目录
├── docker-compose.yml           # Redis容器配置
├── package.json
├── tsconfig.json
└── README.md
```

## 🚀 快速开始

> 💡 **新用户推荐**：查看 [快速启动指南](./quick-start.md) 获取详细的一键启动教程  
> 🌥️ **云端部署**：如遇到npm镜像源问题，查看 [云端部署指南](./cloud-deployment.md)

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
| `WEBHOOK_URL` | Rocket Webhook通知地址 | - |
| `REDIS_URL` | Redis连接地址 | `redis://localhost:6379` |
| `SINGLE_TRANSFER_THRESHOLD` | 单笔转账预警阈值 | `10000` |
| `DAILY_CUMULATIVE_THRESHOLD` | 24小时累计预警阈值 | `50000` |
| `LOG_LEVEL` | 日志级别 | `info` |

### 监控地址

系统监控26个预设地址，包括：
- 主要解锁地址 (2,381,375.14 HYPE)
- 25个其他解锁地址
- 支持自定义预警阈值

## 📊 预警规则

### 1. 单笔转账预警
- **条件**: 单笔转入/转出 ≥ 10,000 HYPE
- **通知**: 立即发送Webhook

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