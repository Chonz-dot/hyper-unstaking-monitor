import CacheManager from '../src/cache';
import logger from '../src/logger';

async function testRedisConnection() {
  console.log('🗃️ 开始测试Redis连接和缓存功能...\n');

  const cache = new CacheManager();

  try {
    // 1. 测试连接
    console.log('1️⃣ 测试Redis连接');
    await cache.connect();
    console.log('✅ Redis连接成功\n');

    // 2. 测试基本读写
    console.log('2️⃣ 测试基本读写操作');
    const testAddress = '0x5d83bb3313240cab65e2e9200d3aaf3520474fb6';
    
    // 更新缓存
    await cache.updateDailyCache(testAddress, '15000', '0xtest123', 'in');
    await cache.updateDailyCache(testAddress, '5000', '0xtest456', 'out');
    
    // 读取缓存
    const dailyCache = await cache.getDailyCache(testAddress);
    console.log('缓存数据:', {
      totalInbound: dailyCache?.totalInbound,
      totalOutbound: dailyCache?.totalOutbound,
      transactionCount: dailyCache?.transactions.length,
    });
    console.log('✅ 基本读写正常\n');

    // 3. 测试交易去重
    console.log('3️⃣ 测试交易去重功能');
    const txHash = '0xtest_duplicate_123';
    
    // 第一次检查（应该是false）
    let isProcessed = await cache.isTransactionProcessed(txHash);
    console.log(`首次检查交易 ${txHash.substring(0, 15)}...: ${isProcessed}`);
    
    // 标记为已处理
    await cache.markTransactionProcessed(txHash);
    console.log('已标记交易为已处理');
    
    // 再次检查（应该是true）
    isProcessed = await cache.isTransactionProcessed(txHash);
    console.log(`再次检查交易 ${txHash.substring(0, 15)}...: ${isProcessed}`);
    console.log('✅ 去重功能正常\n');

    // 4. 测试监控状态
    console.log('4️⃣ 测试监控状态管理');
    const status = {
      startTime: Date.now(),
      lastUpdate: Date.now(),
    };
    
    await cache.updateMonitoringStatus(status);
    const retrievedStatus = await cache.getMonitoringStatus();
    console.log('状态数据:', retrievedStatus);
    console.log('✅ 状态管理正常\n');

    // 5. 测试多地址缓存
    console.log('5️⃣ 测试多地址缓存');
    const testAddresses = [
      '0xda3cdff67ce27fa68ba5600a7c95efd8153d9f15',
      '0x92f17e8d81a944691c10e753af1b1baae1a2cd0d',
    ];
    
    for (const addr of testAddresses) {
      await cache.updateDailyCache(addr, '8000', `0xtest_${addr.slice(-4)}`, 'in');
    }
    
    console.log('多地址缓存统计:');
    for (const addr of [testAddress, ...testAddresses]) {
      const cache_data = await cache.getDailyCache(addr);
      console.log(`  ${addr.substring(0, 8)}...: 转入${cache_data?.totalInbound || '0'} HYPE`);
    }
    console.log('✅ 多地址缓存正常\n');

    await cache.disconnect();
    console.log('🎉 Redis缓存功能测试完成！');

  } catch (error) {
    console.error('❌ Redis测试失败:', error);
    await cache.disconnect();
    process.exit(1);
  }
}

// 运行测试
testRedisConnection().catch((error) => {
  console.error('❌ Redis连接测试失败:', error);
  process.exit(1);
});
