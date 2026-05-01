import { createClient, RedisClientType } from 'redis';
import config from '../config';
import logger from '../logger';

/**
 * 鲸鱼开仓时间记录（每个 address + asset 一条）
 *
 * 需求：模块一告警的"开仓时间"字段 + 模块二播报的"开仓时间"字段
 *
 * 说明：
 * - 对于系统启动前就存在的仓位，记录缺失时返回 null，由上层展示"未知"
 * - key: {prefix}whale:open_time:{address_lower}:{asset}
 * - TTL: 30 天（仓位长于 30 天的极端情况不做处理）
 */
export interface WhaleOpenRecord {
    openTime: number;      // 开仓时间（ms 时间戳）
    entryPrice: number;    // 开仓均价
    openSize: number;      // 开仓数量
    side: 'long' | 'short';
    asset: string;
    address: string;
}

export class WhaleOpenTimeStore {
    private redis: RedisClientType;
    private isConnected = false;
    private readonly TTL_SECONDS = 30 * 24 * 60 * 60; // 30 天

    constructor() {
        this.redis = createClient({ url: config.redis.url });

        this.redis.on('error', (err) => {
            logger.error('WhaleOpenTimeStore Redis 错误:', err);
            this.isConnected = false;
        });
        this.redis.on('ready', () => {
            this.isConnected = true;
        });
        this.redis.on('end', () => {
            this.isConnected = false;
        });
    }

    async connect(): Promise<void> {
        await this.redis.connect();
        logger.info('🐋 WhaleOpenTimeStore Redis 连接就绪', {
            keyPrefix: config.redis.keyPrefix
        });
    }

    async disconnect(): Promise<void> {
        try {
            await this.redis.disconnect();
        } catch (error) {
            logger.warn('WhaleOpenTimeStore 断开连接失败:', error);
        }
    }

    private buildKey(address: string, asset: string): string {
        return `${config.redis.keyPrefix}whale:open_time:${address.toLowerCase()}:${asset}`;
    }

    /**
     * 记录一次新开仓
     */
    async recordOpen(record: WhaleOpenRecord): Promise<void> {
        if (!this.isConnected) {
            logger.warn('🐋 WhaleOpenTimeStore 未连接，跳过开仓记录', {
                address: record.address,
                asset: record.asset
            });
            return;
        }

        try {
            const key = this.buildKey(record.address, record.asset);
            await this.redis.setEx(key, this.TTL_SECONDS, JSON.stringify(record));
            logger.info('🐋 已记录开仓时间', {
                address: record.address,
                asset: record.asset,
                openTime: new Date(record.openTime).toISOString(),
                entryPrice: record.entryPrice,
                side: record.side
            });
        } catch (error) {
            logger.error('🐋 记录开仓时间失败:', error);
        }
    }

    /**
     * 查询开仓记录
     */
    async getOpen(address: string, asset: string): Promise<WhaleOpenRecord | null> {
        if (!this.isConnected) return null;

        try {
            const key = this.buildKey(address, asset);
            const raw = await this.redis.get(key);
            return raw ? JSON.parse(raw) as WhaleOpenRecord : null;
        } catch (error) {
            logger.warn('🐋 查询开仓时间失败:', error);
            return null;
        }
    }

    /**
     * 清除开仓记录（平仓时调用）
     */
    async clearOpen(address: string, asset: string): Promise<void> {
        if (!this.isConnected) return;

        try {
            const key = this.buildKey(address, asset);
            await this.redis.del(key);
            logger.debug('🐋 已清除开仓记录', { address, asset });
        } catch (error) {
            logger.warn('🐋 清除开仓时间失败:', error);
        }
    }
}

export default WhaleOpenTimeStore;
