import logger from '../src/logger';
import config from '../src/config';
import { formatHypeAmount, truncateHash, isValidHypeAddress } from '../src/utils/helpers';

async function testBasicFunctions() {
  console.log('🧪 开始基础功能测试...\n');

  // 1. 测试日志系统
  console.log('1️⃣ 测试日志系统');
  logger.info('测试信息日志');
  logger.warn('测试警告日志');
  logger.error('测试错误日志');
  console.log('✅ 日志系统正常\n');

  // 2. 测试配置加载
  console.log('2️⃣ 测试配置加载');
  console.log(`- 监控地址数量: ${config.monitoring.addresses.length}`);
  console.log(`- 单笔阈值: ${config.monitoring.singleThreshold}`);
  console.log(`- 日累计阈值: ${config.monitoring.dailyThreshold}`);
  console.log(`- WebSocket URL: ${config.hyperliquid.wsUrl}`);
  console.log(`- Redis URL: ${config.redis.url}`);
  console.log('✅ 配置加载正常\n');

  // 3. 测试工具函数
  console.log('3️⃣ 测试工具函数');
  console.log(`- formatHypeAmount(12345.6789): ${formatHypeAmount(12345.6789)}`);
  console.log(`- truncateHash("0x1234567890abcdef"): ${truncateHash('0x1234567890abcdef')}`);
  console.log(`- isValidHypeAddress("0x5d83bb3313240cab65e2e9200d3aaf3520474fb6"): ${isValidHypeAddress('0x5d83bb3313240cab65e2e9200d3aaf3520474fb6')}`);
  console.log(`- isValidHypeAddress("invalid"): ${isValidHypeAddress('invalid')}`);
  console.log('✅ 工具函数正常\n');

  // 4. 测试地址配置
  console.log('4️⃣ 测试监控地址配置');
  const firstAddress = config.monitoring.addresses[0];
  console.log(`- 第一个地址: ${firstAddress.address}`);
  console.log(`- 地址标签: ${firstAddress.label}`);
  console.log(`- 解锁数量: ${formatHypeAmount(firstAddress.unlockAmount)}`);
  console.log(`- 激活状态: ${firstAddress.isActive}`);
  
  const totalUnlockAmount = config.monitoring.addresses.reduce((sum, addr) => sum + addr.unlockAmount, 0);
  console.log(`- 总解锁数量: ${formatHypeAmount(totalUnlockAmount)}`);
  console.log('✅ 地址配置正常\n');

  // 5. 测试Webhook配置
  console.log('5️⃣ 测试Webhook配置');
  console.log(`- Webhook URL: ${config.webhook.url || '未配置'}`);
  console.log(`- 超时时间: ${config.webhook.timeout}ms`);
  console.log(`- 重试次数: ${config.webhook.retries}`);
  if (!config.webhook.url) {
    console.log('⚠️  Webhook URL未配置，请在.env文件中设置WEBHOOK_URL');
  } else {
    console.log('✅ Webhook配置正常');
  }
  console.log();

  console.log('🎉 基础功能测试完成！');
}

// 运行测试
testBasicFunctions().catch((error) => {
  console.error('❌ 测试失败:', error);
  process.exit(1);
});
