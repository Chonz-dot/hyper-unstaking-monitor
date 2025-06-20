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

### 1. 安装依赖
```bash
npm install
```

### 2. 启动Redis服务
```bash
npm run docker:up
```

### 3. 配置环境变量
```bash
cp .env.example .env
# 编辑 .env 文件，配置Webhook URL等参数
```

### 4. 启动监控系统
```bash
# 开发模式
npm run dev

# 生产模式
npm run build && npm start
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

### 脚本命令
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

---

**版本**: 1.0.0  
**最后更新**: 2025年6月  
**开发者**: Edison
### 调试技巧

```bash
# 设置调试级别
export LOG_LEVEL=debug

# 查看详细日志
./manage.sh logs

# 测试Webhook连接
curl -X POST $WEBHOOK_URL \
  -H "Content-Type: application/json" \
  -d '{"test": "webhook connection"}'

# 检查Redis连接
redis-cli ping

# 监控WebSocket连接
./manage.sh status
```

### 常见问题排查

**1. WebSocket连接失败**
```bash
# 检查网络连接
ping api.hyperliquid.xyz

# 查看错误日志
grep "WebSocket" logs/monitor.log
```

**2. Redis连接问题**
```bash
# 检查Redis服务
systemctl status redis
# 或
brew services list | grep redis

# 测试连接
redis-cli -u $REDIS_URL ping
```

**3. Webhook发送失败**
```bash
# 检查Webhook配置
grep "WEBHOOK" .env

# 查看发送日志
grep "webhook" logs/monitor.log
```

## 📈 监控指标

### 系统指标

- **连接状态**：WebSocket连接数和状态
- **处理性能**：事件处理延迟和吞吐量
- **缓存使用**：Redis内存使用和命中率
- **警报统计**：触发次数和类型分布

### 业务指标

- **转账监控**：单笔和累计转账量
- **地址活跃度**：各地址转账频率
- **时间分布**：转账时间模式分析
- **异常检测**：大额转账预警统计

## 🔒 安全建议

### 生产环境配置

```bash
# 设置严格的文件权限
chmod 600 .env
chmod 755 manage.sh

# 使用环境变量而非硬编码
export REDIS_PASSWORD="your-secure-password"
export WEBHOOK_SECRET="your-webhook-secret"

# 启用日志轮转
# 在 /etc/logrotate.d/hype-monitor 中配置
```

### 网络安全

- 使用HTTPS Webhook端点
- 配置Redis密码认证
- 限制服务器出入站规则
- 定期更新依赖包安全补丁

## 🚨 故障处理

### 自动恢复机制

系统内置多层故障恢复：

1. **WebSocket重连**：自动重连，指数退避
2. **批次隔离**：单批次失败不影响其他批次
3. **缓存容错**：Redis不可用时降级处理
4. **Webhook重试**：失败自动重试，最大3次

### 手动恢复

```bash
# 重启所有服务
./manage.sh restart

# 清理并重启
./manage.sh clean
./manage.sh install
./manage.sh pm2

# 检查系统状态
./manage.sh status
./manage.sh logs
```

## 📝 更新日志

### v1.2.0 (最新) - 2025-06-20

**🎯 主要更新**
- ✅ **修复误报问题**：优化数据解析器，过滤订单修改事件
- ✅ **统一管理脚本**：新增 `manage.sh` 脚本，简化操作
- ✅ **项目结构优化**：清理不必要文件，精简目录结构
- ✅ **事件过滤增强**：只监控真实转账事件

**🔧 技术改进**
- 改进 `HyperliquidDataParser` 事件过滤逻辑
- 优化 WebSocket 事件处理流程
- 增强日志记录和错误处理
- 标准化项目管理命令

**📋 文件变更**
- 新增：`manage.sh` - 统一管理脚本
- 更新：`src/utils/data-parser.ts` - 优化事件过滤
- 更新：`src/services/hyperliquid-monitor.ts` - 改进事件处理
- 移除：`dev.sh`, `start.sh`, `restart.sh`, `deploy.sh` - 合并到管理脚本
- 清理：`dist/`, `tests/` - 构建产物和测试目录

### v1.1.0 - 2025-06-15
- 批量监控支持
- Redis缓存优化
- Webhook重试机制

### v1.0.0 - 2025-06-10
- 基础监控功能
- 预警引擎
- Docker支持

## 🤝 贡献指南

### 开发流程

1. **Fork项目**并创建特性分支
2. **本地开发**：`./manage.sh dev`
3. **运行测试**：`./manage.sh test`（如果有测试）
4. **提交代码**：遵循[Conventional Commits](https://conventionalcommits.org/)规范
5. **创建PR**：描述变更内容和测试结果

### 代码规范

```bash
# 代码格式化
npm run format

# 类型检查
npm run type-check

# 代码检查
npm run lint
```

## 📄 许可证

本项目采用 MIT 许可证 - 详见 [LICENSE](LICENSE) 文件

## 📞 技术支持

- **文档问题**：查看 `masterplan.md` 需求文档
- **部署问题**：查看 `DEPLOYMENT.md` 部署指南
- **日志分析**：使用 `./manage.sh logs` 查看运行日志
- **性能调优**：调整批次大小和缓存配置

## 🎯 路线图

### 近期计划

- [ ] Web管理界面
- [ ] 更多通知渠道（Telegram、Discord）
- [ ] 监控数据可视化
- [ ] 历史数据查询API

### 长期规划

- [ ] 多链监控支持
- [ ] 机器学习异常检测
- [ ] 高可用集群部署
- [ ] 实时监控仪表板

---

## 🔗 相关链接

- [Hyperliquid官方文档](https://hyperliquid.gitbook.io/)
- [WebSocket API参考](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket)
- [Redis文档](https://redis.io/documentation)
- [PM2进程管理](https://pm2.keymetrics.io/)

---

**⚡ 快速命令参考：**

```bash
# 🚀 常用操作
./manage.sh dev          # 开发模式
./manage.sh pm2          # 生产启动
./manage.sh logs         # 查看日志
./manage.sh status       # 服务状态
./manage.sh deploy       # 一键部署
./manage.sh clean        # 清理文件

# 📊 监控操作
./manage.sh restart      # 重启服务
./manage.sh stop         # 停止服务
curl $WEBHOOK_URL        # 测试Webhook
redis-cli ping           # 测试Redis
```

> 💡 **提示**：使用 `./manage.sh` 查看所有可用命令和使用说明

---

*最后更新：2025-06-20*