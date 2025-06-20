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
    // 格式化金额显示
    const formatAmount = (amount: string) => {
      const num = parseFloat(amount);
      return num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    };

    // 计算占解锁总量的百分比
    const calculatePercentage = (amount: string, total?: number) => {
      if (!total || total === 0) return '';
      const percentage = (parseFloat(amount) / total) * 100;
      return ` (${percentage.toFixed(4)}% of unlock amount)`;
    };

    // 确定警报级别和类型
    const isTransferIn = alert.alertType.includes('_in');
    const isSingle = alert.alertType.includes('single_');

    // 警报级别判定
    let alertLevel = 'LOW';
    let alertEmoji = 'ℹ️';

    if (parseFloat(alert.amount) >= 100000) {
      alertLevel = 'HIGH';
      alertEmoji = '🚨';
    } else if (parseFloat(alert.amount) >= 50000) {
      alertLevel = 'MEDIUM';
      alertEmoji = '⚠️';
    }

    const actionText = isTransferIn ? 'Transfer In' : 'Transfer Out';
    const thresholdType = isSingle ? 'Large Single' : '24h Cumulative';
    const directionEmoji = isTransferIn ? '📈' : '📉';

    // 构建简化的消息内容（移除折叠部分）
    const messageLines = [
      `${alertEmoji} ${alertEmoji} ${alertLevel} ALERT: ${thresholdType} ${actionText}`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `🌐 Network: Hyperliquid`,
      `Token: HYPE`,
      `Amount: ${formatAmount(alert.amount)}${calculatePercentage(alert.amount, alert.unlockAmount)}`,
      `Address: ${alert.address} (${alert.addressLabel || 'Unknown'})`,
      `${alert.unlockAmount ? `Unlock Total: ${formatAmount(alert.unlockAmount.toString())} HYPE` : ''}`,
      `Transaction: ${alert.txHash}`,
      `Time: ${new Date(alert.blockTime).toISOString()}`,
      `${alert.cumulativeToday ? `24h Cumulative: ${formatAmount(alert.cumulativeToday)} HYPE` : ''}`,
      `Explorer Link: https://hypurrscan.io/tx/${alert.txHash}`
    ].filter(line => line !== ''); // 过滤空行

    // 简化的 payload，移除复杂的 attachments 和折叠部分
    const simplePayload = {
      text: messageLines.join('\n'),
      username: 'HYPE Monitor',
      icon_emoji: ':robot:',
      // 保留基本的元数据
      alert_info: {
        alert_level: alertLevel,
        amount: formatAmount(alert.amount),
        network: 'Hyperliquid',
        address_label: alert.addressLabel || 'Unknown',
        address: alert.address,
        transaction_hash: alert.txHash,
        unlock_amount: alert.unlockAmount ? formatAmount(alert.unlockAmount.toString()) : null,
        percentage: alert.unlockAmount ? ((parseFloat(alert.amount) / alert.unlockAmount) * 100).toFixed(4) + '%' : null,
        cumulative_24h: alert.cumulativeToday ? formatAmount(alert.cumulativeToday) : null,
        explorer_link: `https://hypurrscan.io/tx/${alert.txHash}`
      },
      // 原始数据
      raw_alert: alert,
      metadata: {
        system: 'hype-unstaking-monitor',
        version: '1.2.0',
        timestamp_iso: new Date(alert.timestamp).toISOString(),
        action_type: actionText,
        threshold_type: thresholdType,
        alert_level: alertLevel
      }
    };

    const response = await axios.post(this.webhookUrl, simplePayload, {
      timeout: this.timeout,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'HYPE-Monitor/1.2',
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
}

export default WebhookNotifier;
