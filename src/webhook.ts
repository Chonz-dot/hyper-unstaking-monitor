import axios from 'axios';
import config from './config';
import logger from './logger';
import { WebhookAlert } from './types';

export class WebhookNotifier {
  private webhookUrl: string;
  private timeout: number;
  private maxRetries: number;

  constructor() {
    this.webhookUrl = config.webhook.url;
    this.timeout = config.webhook.timeout;
    this.maxRetries = config.webhook.retries;

    if (!this.webhookUrl) {
      logger.warn('Webhook URL未配置，警报通知将被禁用');
    }
  }

  async sendAlert(alert: WebhookAlert): Promise<void> {
    if (!this.webhookUrl) {
      logger.warn('Webhook URL未配置，跳过警报发送');
      return;
    }

    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        await this.makeRequest(alert);
        logger.info(`警报发送成功: ${alert.alertType} for ${alert.addressLabel}`, {
          attempt,
          amount: alert.amount,
          txHash: alert.txHash.substring(0, 10) + '...',
        });
        return;
        
      } catch (error) {
        lastError = error as Error;
        logger.warn(`警报发送失败 (尝试 ${attempt}/${this.maxRetries}):`, {
          error: lastError.message,
          alertType: alert.alertType,
          address: alert.address,
        });

        // 如果不是最后一次尝试，等待后重试
        if (attempt < this.maxRetries) {
          const delay = this.getRetryDelay(attempt);
          await this.sleep(delay);
        }
      }
    }

    // 所有重试都失败了
    logger.error(`警报发送完全失败: ${alert.alertType}`, {
      address: alert.address,
      attempts: this.maxRetries,
      finalError: lastError?.message,
    });
  }

  private async makeRequest(alert: WebhookAlert): Promise<void> {
    const payload = {
      ...alert,
      // 添加一些额外的元数据
      metadata: {
        system: 'hype-unstaking-monitor',
        version: '1.0.0',
        timestamp_iso: new Date(alert.timestamp).toISOString(),
      },
    };

    const response = await axios.post(this.webhookUrl, payload, {
      timeout: this.timeout,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'HYPE-Monitor/1.0',
      },
    });

    // 检查响应状态
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
  }

  private getRetryDelay(attempt: number): number {
    // 指数退避策略：1s, 2s, 4s
    return Math.min(1000 * Math.pow(2, attempt - 1), 10000);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // 测试Webhook连接
  async testConnection(): Promise<boolean> {
    if (!this.webhookUrl) {
      logger.error('Webhook URL未配置，无法测试连接');
      return false;
    }

    try {
      const testPayload = {
        timestamp: Date.now(),
        alertType: 'test_connection',
        message: 'HYPE监控系统连接测试',
        system: 'hype-unstaking-monitor',
      };

      await axios.post(this.webhookUrl, testPayload, {
        timeout: this.timeout,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'HYPE-Monitor/1.0',
        },
      });

      logger.info('Webhook连接测试成功');
      return true;
      
    } catch (error) {
      logger.error('Webhook连接测试失败:', error);
      return false;
    }
  }
}

export default WebhookNotifier;
