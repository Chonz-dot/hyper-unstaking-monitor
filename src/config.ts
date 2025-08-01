import dotenv from 'dotenv';
import { Config, WatchedAddress, ContractTrader, MonitorType } from './types';

// 加载环境变量
dotenv.config();

// 监控地址列表（基于您提供的数据）
const WATCHED_ADDRESSES: WatchedAddress[] = [
  { address: '0x5d83bb3313240cab65e2e9200d3aaf3520474fb6', label: '主要解锁地址', unlockAmount: 2381375.14, isActive: true },
  { address: '0xda3cdff67ce27fa68ba5600a7c95efd8153d9f15', label: '解锁地址2', unlockAmount: 300000.00, isActive: true },
  { address: '0x92f17e8d81a944691c10e753af1b1baae1a2cd0d', label: '解锁地址3', unlockAmount: 136552.58, isActive: true },
  { address: '0x4016f161f022cbeb49b2932cb0bc9c92ded5acb6', label: '解锁地址4', unlockAmount: 100269.49, isActive: true },
  { address: '0xa69e24a291687a7cc0bb1d8bc09ba74e667d4d9e', label: '解锁地址5', unlockAmount: 100000.00, isActive: true },
  { address: '0x6891ed9ee6a9d0649ffac2bcee814e6899a0e075', label: '解锁地址6', unlockAmount: 90908.06, isActive: true },
  { address: '0xfc4d472cd0c5a3160e929498339e6f0d3b9c10b4', label: '解锁地址7', unlockAmount: 80036.65, isActive: true },
  { address: '0xa567501abf12f401c9e613b6323c43cf29b0f92c', label: '解锁地址8', unlockAmount: 70588.59, isActive: true },
  { address: '0xa57e1325a11e30c6918573300d73e8142e17f1bd', label: '解锁地址9', unlockAmount: 50000.00, isActive: true },
  { address: '0x53babe76166eae33c861aeddf9ce89af20311cd0', label: '解锁地址10', unlockAmount: 49860.00, isActive: true },
  { address: '0xa56b038e765056e30d26d738497ba78fdf8df4e8', label: '解锁地址11', unlockAmount: 48174.56, isActive: true },
  { address: '0xe912cac1a6641004a8803687ee7699227fdb0550', label: '解锁地址12', unlockAmount: 40097.52, isActive: true },
  { address: '0x23c349d1a486ec8d616329dbcacfa65b13b72e91', label: '解锁地址13', unlockAmount: 34722.79, isActive: true },
  { address: '0x9c68cd0568eb47bad36ecd8090e6c1d1396a7783', label: '解锁地址14', unlockAmount: 33000.00, isActive: true },
  { address: '0x34971bc50eb4484505e4a24516c8db843fbef162', label: '解锁地址15', unlockAmount: 30000.00, isActive: true },
  { address: '0xaccabdd61b9ed9834a2223864c69dcb61e98c000', label: '解锁地址16', unlockAmount: 29833.77, isActive: true },
  { address: '0xabc9eda0988d43f9c5ca1f380e6fb2bccc5a01d2', label: '解锁地址17', unlockAmount: 27209.25, isActive: true },
  { address: '0x68a410113fab274d4e66685c1242e289ae76c01a', label: '解锁地址18', unlockAmount: 25618.89, isActive: true },
  { address: '0x9aae30fa4abb0afe9df5c1e21e22360730d00f49', label: '解锁地址19', unlockAmount: 25203.53, isActive: true },
  { address: '0xbb10bda01f56b1604f2f024f2d18fcaf5d2b20b0', label: '解锁地址20', unlockAmount: 25135.68, isActive: true },
  { address: '0x2b2553114287fc198252d66b21f9b33783fcbb7d', label: '解锁地址21', unlockAmount: 25090.00, isActive: true },
  { address: '0xc81ed8f3c8beedccc10247c1b0a8885075bc3c98', label: '解锁地址22', unlockAmount: 25004.00, isActive: true },
  { address: '0x790b7fd80043aafd0b6b040990fb6fe74f482293', label: '解锁地址23', unlockAmount: 23417.20, isActive: true },
  { address: '0xdcb0b5e41d6ed4dd834316d4177d73452014f983', label: '解锁地址24', unlockAmount: 20136.00, isActive: true },
  { address: '0xf4b03f6bf1c7d529194410dc3d0775a1d7bff09b', label: '解锁地址25', unlockAmount: 20036.19, isActive: true },
  { address: '0x7bfee91193d9df2ac0bfe90191d40f23c773c060', label: '解锁地址26', unlockAmount: 20000.00, isActive: true },
  // todo 增加下面这些账户的转账阈值监控
  { address: '0x43e9abea1910387c4292bca4b94de81462f8a251', label: 'HyperLabs团队地址(大户监控)', unlockAmount: 0, isActive: true }, // 2.4亿HYPE，预计2025/11/28开始解锁
  { address: '0xd57ecca444a9acb7208d286be439de12dd09de5d', label: 'Hyper Foundation基金会(大户监控)', unlockAmount: 0, isActive: true }, // 6000万HYPE
  { address: '0xfefefefefefefefefefefefefefefefefefefefe', label: 'Assistance Fund援助基金(大户监控)', unlockAmount: 0, isActive: true }, // 2600万HYPE，未质押
  { address: '0x4e14fc11f58b64740e66e4b1aa188a4b007c0eab', label: '最大个人活跃地址(大户监控)', unlockAmount: 0, isActive: true }, // 149万HYPE，未质押，流动性最强
  { address: '0x9794bbbc222b6b93c1417d01aa1ff06d42e5333b', label: 'smartestmoney传奇交易员(大户监控)', unlockAmount: 0, isActive: true }, // 300万HYPE已质押+50万EVM
  { address: '0xfae95f601f3a25ace60d19dbb929f2a5c57e3571', label: 'laurentzeimes第二大个人(大户监控)', unlockAmount: 0, isActive: true }, // 330万HYPE已质押
  { address: '0x51156f7002c4f74f4956c9e0f2b7bfb6e9dbfac2', label: 'ellie_nfts地址1(大户监控)', unlockAmount: 0, isActive: true }, // 集群共240万
  { address: '0xba60e7e6c222a6eca70abb6bb011c40fdaaa565b', label: 'ellie_nfts地址2(大户监控)', unlockAmount: 0, isActive: true },
  { address: '0x9a4a2224eb1ce642a497738e6e1227a0411f3679', label: 'ellie_nfts地址3(大户监控)', unlockAmount: 0, isActive: true },
  { address: '0xfdc5a81605d8b926947d2e865f74025dd53ac314', label: '神秘巨鲸集群1(大户监控)', unlockAmount: 0, isActive: true }, // 集群共230万HYPE
  { address: '0x5d83bb3313240cab65e2e9200d3aaf3520474fb6', label: '神秘巨鲸集群2(大户监控)', unlockAmount: 0, isActive: true },
  { address: '0x316fc62528c317e569fe5aa4df6c1af0c4f2e678', label: '神秘巨鲸集群3(大户监控)', unlockAmount: 0, isActive: true },
  { address: '0x5b5d51203a0f9079f8aeb098a6523a13f298c060', label: 'Abraxas Capital机构1(大户监控)', unlockAmount: 0, isActive: true }, // 共229万
  { address: '0xb83de012dba672c76a7dbbbf3e459cb59d7d6e36', label: 'Abraxas Capital机构2(大户监控)', unlockAmount: 0, isActive: true },
  { address: '0xcaC19662Ec88d23Fa1c81aC0e8570B0cf2FF26b3', label: 'Galaxy Digital机构1(大户监控)', unlockAmount: 0, isActive: true }, // 共180万
  { address: '0x62bc1fe6009388219dd84f9dca37930f6fb6fa22', label: 'Galaxy Digital机构2(大户监控)', unlockAmount: 0, isActive: true },
  { address: '0xcfdb74a8c080bb7b4360ed6fe21f895c653efff4', label: 'Amber Group机构(大户监控)', unlockAmount: 0, isActive: true }, // 150万HYPE
  { address: '0x77c3ea550d2da44b120e55071f57a108f8dd5e45', label: 'HYPE 股票第二大持有者（3.8 亿美元）(大户监控)', unlockAmount: 0, isActive: true }, // 150万HYPE
];

// 合约交易员监控列表
const CONTRACT_TRADERS: ContractTrader[] = [
  { address: '0xfa6af5f4f7440ce389a1e650991eea45c161e13e', label: '交易员1', description: 'hyperdash交易员', isActive: true },
  { address: '0xa04a4b7b7c37dbd271fdc57618e9cb9836b250bf', label: '交易员2', description: 'hyperdash交易员', isActive: true },
  { address: '0xb8b9e3097c8b1dddf9c5ea9d48a7ebeaf09d67d2', label: '交易员3', description: 'hyperdash交易员', isActive: true },
  { address: '0xd5ff5491f6f3c80438e02c281726757baf4d1070', label: '交易员4', description: 'hyperdash交易员', isActive: true },
  { address: '0x45090576dEBb996eeFe85C1269E8772F8B08025A', label: 'test', description: 'hyperdash交易员', isActive: true },
];

export const config: Config = {
  hyperliquid: {
    wsUrl: process.env.HYPERLIQUID_WS_URL || 'wss://api.hyperliquid.xyz/ws',
    reconnectAttempts: parseInt(process.env.HYPERLIQUID_RECONNECT_ATTEMPTS || '5'),
    connectionTimeout: parseInt(process.env.CONNECTION_TIMEOUT || '45000'),
    subscriptionTimeout: parseInt(process.env.SUBSCRIPTION_TIMEOUT || '35000'),
    connectionDelay: parseInt(process.env.CONNECTION_DELAY || '15000'),
    keepAliveInterval: parseInt(process.env.KEEP_ALIVE_INTERVAL || '30000'),
    keepAliveTimeout: parseInt(process.env.KEEP_ALIVE_TIMEOUT || '25000'),
    maxConsecutiveErrors: parseInt(process.env.MAX_CONSECUTIVE_ERRORS || '10'),
    maxReconnectAttempts: parseInt(process.env.MAX_RECONNECT_ATTEMPTS || '5'),
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    keyPrefix: process.env.REDIS_KEY_PREFIX || 'hype_monitor:',
  },
  webhook: {
    transferUrl: process.env.WEBHOOK_URL || '',
    contractUrl: process.env.CONTRACT_WEBHOOK_URL,
    timeout: parseInt(process.env.WEBHOOK_TIMEOUT || '5000'),
    retries: parseInt(process.env.WEBHOOK_RETRIES || '3'),
  },
  monitoring: {
    singleThreshold: parseFloat(process.env.SINGLE_TRANSFER_THRESHOLD || '10000'),
    cumulative24hThreshold: parseFloat(process.env.CUMULATIVE_24H_THRESHOLD || '50000'),
    addresses: WATCHED_ADDRESSES,
  },
  contractMonitoring: {
    enabled: process.env.CONTRACT_MONITORING_ENABLED === 'true',
    traders: CONTRACT_TRADERS,
    minNotionalValue: parseFloat(process.env.CONTRACT_MIN_NOTIONAL || '100'), // 降低到100美元名义价值
    assets: process.env.CONTRACT_ASSETS ? process.env.CONTRACT_ASSETS.split(',') : undefined,
    monitorType: (process.env.CONTRACT_MONITOR_TYPE as MonitorType) || 'pure-rpc', // 默认使用纯净RPC监控器
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    file: process.env.LOG_FILE,
  },
};

export default config;
