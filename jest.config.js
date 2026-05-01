/**
 * Jest 配置：通过 ts-jest 让 Jest 直接跑 .test.ts。
 *
 * 只挑 tests/ 下的 .test.ts 运行；tests/ 下其他 .ts 是手写调试脚本（不是测试）。
 * 同时忽略历史遗留的 tests/contractMonitorDebounce.test.ts（它引用的
 * src/services/contractMonitor.ts 已不存在，不在本次需求范围内）。
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '/tests/contractMonitorDebounce\\.test\\.ts$'
  ],
  // 静默 logger 的 winston 输出（不影响断言，只让测试日志干净）
  silent: false
};
