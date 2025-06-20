import WebhookNotifier from '../src/webhook';
import logger from '../src/logger';
import { WebhookAlert } from '../src/types';

async function testWebhookNotifier() {
  console.log('📡 开始测试Webhook通知功能...\n');

  const notifier = new WebhookNotifier();

  // 1. 测试连接
  console.log('1️⃣ 测试Webhook连接');
  const connectionTest = await notifier.testConnection();
  console.log(`连接测试结果: ${connectionTest ? '✅ 成功' : '❌ 失败'}\n`);

  // 2. 测试单笔转入预警
  console.log('2️⃣ 测试单笔转入预警通知');
  const singleTransferAlert: WebhookAlert = {
    timestamp: Date.now(),
    alertType: 'single_transfer_in',
    address: '0x5d83bb3313240cab65e2e9200d3aaf3520474fb6',
    addressLabel: '主要解锁地址',
    amount: '15000',
    txHash: '0xtest123456789abcdef',
    blockTime: Date.now() - 1000,
    unlockAmount: 2381375.14,
  };

  try {
    await notifier.sendAlert(singleTransferAlert);
    console.log('✅ 单笔转入预警发送成功\n');
  } catch (error) {
    console.log('❌ 单笔转入预警发送失败:', error);
  }

  // 3. 测试累计转账预警
  console.log('3️⃣ 测试累计转账预警通知');
  const cumulativeAlert: WebhookAlert = {
    timestamp: Date.now(),
    alertType: 'cumulative_transfer_out',
    address: '0xda3cdff67ce27fa68ba5600a7c95efd8153d9f15',
    addressLabel: '解锁地址2',
    amount: '8000',
    txHash: '0xtest987654321fedcba',
    blockTime: Date.now() - 2000,
    cumulativeToday: '55000',
    unlockAmount: 300000.00,
  };

  try {
    await notifier.sendAlert(cumulativeAlert);
    console.log('✅ 累计转账预警发送成功\n');
  } catch (error) {
    console.log('❌ 累计转账预警发送失败:', error);
  }

  console.log('🎉 Webhook通知功能测试完成！');
}

// 运行测试
testWebhookNotifier().catch((error) => {
  console.error('❌ Webhook测试失败:', error);
  process.exit(1);
});
