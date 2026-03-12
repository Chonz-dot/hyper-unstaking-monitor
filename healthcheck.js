/**
 * Docker 健康检查脚本
 * 检查应用是否在正常运行：
 * 1. 健康检查文件是否存在
 * 2. 文件最后更新时间是否在 90 秒内（允许 30 秒轮询间隔 + 容错）
 */
const fs = require('fs');
const path = require('path');

const HEALTH_FILE = path.join('/tmp', '.healthcheck');
const MAX_STALE_MS = 90000; // 90秒内必须有更新

try {
  if (!fs.existsSync(HEALTH_FILE)) {
    console.error('健康检查文件不存在');
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf-8'));
  const age = Date.now() - data.timestamp;

  if (age > MAX_STALE_MS) {
    console.error(`健康检查过期: ${Math.round(age / 1000)}秒前更新`);
    process.exit(1);
  }

  if (!data.isRunning) {
    console.error('应用标记为未运行');
    process.exit(1);
  }

  process.exit(0);
} catch (error) {
  console.error('健康检查失败:', error.message);
  process.exit(1);
}
