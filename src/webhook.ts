import axios from 'axios';
import config from './config';
import logger from './logger';
import { WebhookAlert, ContractWebhookAlert } from './types';

export class WebhookNotifier {
  private transferWebhookUrl: string;
  private contractWebhookUrl: string | undefined;
  private timeout: number;
  private maxRetries: number;

  constructor() {
    this.transferWebhookUrl = config.webhook.transferUrl;
    this.contractWebhookUrl = config.webhook.contractUrl;
    this.timeout = config.webhook.timeout;
    this.maxRetries = config.webhook.retries;

    if (!this.transferWebhookUrl) {
      logger.warn('转账监控Webhook URL未配置，转账警报通知将被禁用');
    }

    if (!this.contractWebhookUrl) {
      logger.warn('合约监控Webhook URL未配置，合约警报通知将被禁用');
    }
  }

  async sendAlert(alert: WebhookAlert): Promise<void> {
    if (!this.transferWebhookUrl) {
      logger.warn('转账Webhook URL未配置，跳过转账警报发送');
      return;
    }

    await this.sendWebhook(this.transferWebhookUrl, alert, 'transfer');
  }

  async sendContractAlert(alert: ContractWebhookAlert): Promise<void> {
    if (!this.contractWebhookUrl) {
      logger.warn('合约Webhook URL未配置，跳过合约警报发送');
      return;
    }

    await this.sendWebhook(this.contractWebhookUrl, alert, 'contract');
  }

  private async sendWebhook(webhookUrl: string, alert: WebhookAlert | ContractWebhookAlert, type: 'transfer' | 'contract'): Promise<void> {

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        if (type === 'transfer') {
          await this.makeTransferRequest(webhookUrl, alert as WebhookAlert);
        } else {
          await this.makeContractRequest(webhookUrl, alert as ContractWebhookAlert);
        }

        const alertType = 'alertType' in alert ? alert.alertType : 'unknown';
        const label = 'addressLabel' in alert ? alert.addressLabel : ('traderLabel' in alert ? alert.traderLabel : 'unknown');

        logger.info(`${type}警报发送成功: ${alertType} for ${label}`, {
          attempt,
          address: alert.address
        });
        return;

      } catch (error) {
        lastError = error as Error;
        const alertType = 'alertType' in alert ? alert.alertType : 'unknown';

        logger.warn(`${type}警报发送失败 (尝试 ${attempt}/${this.maxRetries}):`, {
          error: lastError.message,
          alertType,
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
    const alertType = 'alertType' in alert ? alert.alertType : 'unknown';
    logger.error(`${type}警报发送完全失败: ${alertType}`, {
      address: alert.address,
      attempts: this.maxRetries,
      finalError: lastError?.message,
    });
  }

  private async makeTransferRequest(webhookUrl: string, alert: WebhookAlert): Promise<void> {
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

    const response = await axios.post(webhookUrl, simplePayload, {
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

  private async makeContractRequest(webhookUrl: string, alert: ContractWebhookAlert): Promise<void> {
    // 格式化金额显示
    const formatAmount = (amount: string) => {
      const num = parseFloat(amount);
      return num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 4 });
    };

    // 确定警报级别和类型 - 更新图标系统
    let alertLevel = 'INFO';
    let actionEmoji = '📊'; // 默认图标

    // 根据动作类型选择专属图标
    const getActionInfo = (alertType: string, side: string) => {
      switch (alertType) {
        case 'position_open_long':
          return {
            text: 'Long Position Opened',
            emoji: '🟢', // 绿色圆圈表示开多
            color: 0x00FF00
          };
        case 'position_open_short':
          return {
            text: 'Short Position Opened',
            emoji: '🔴', // 红色圆圈表示开空
            color: 0xFF0000
          };
        case 'position_close':
          return {
            text: 'Position Closed',
            emoji: '⭕', // 圆形表示平仓/关闭
            color: 0xFFFF00
          };
        case 'position_increase':
          return {
            text: side === 'long' ? 'Long Position Increased' : 'Short Position Increased',
            emoji: '➕', // 加号表示加仓
            color: 0x0099FF
          };
        case 'position_decrease':
          return {
            text: side === 'long' ? 'Long Position Decreased' : 'Short Position Decreased',
            emoji: '➖', // 减号表示减仓
            color: 0xFF9900
          };
        default:
          return {
            text: 'Position Updated',
            emoji: '📊',
            color: 0x808080
          };
      }
    };

    const actionInfo = getActionInfo(alert.alertType, alert.side);

    // 根据名义价值调整警报级别
    const notionalValue = parseFloat(alert.notionalValue || '0');
    if (notionalValue >= 100000) {
      alertLevel = 'HIGH';
    } else if (notionalValue >= 10000) {
      alertLevel = 'MEDIUM';
    }

    // 操作类型转换
    const getActionText = (alertType: string) => {
      switch (alertType) {
        case 'position_open_long': return 'Long Position Opened';
        case 'position_open_short': return 'Short Position Opened';
        case 'position_close': return 'Position Closed';
        case 'position_increase': return 'Position Increased';
        case 'position_decrease': return 'Position Decreased';
        default: return 'Position Updated';
      }
    };

    const actionText = getActionText(alert.alertType);
    const sideEmoji = alert.side === 'long' ? '📈' : '📉';

    // 简化交易员显示：合并标签和地址
    const traderDisplay = `${alert.traderLabel || 'Unknown'} (${alert.address})`;

    // 创建简洁的纯文本消息
    const messageText = [
      `${actionInfo.emoji} **Contract Signal**: ${actionInfo.text}`,
      ``,
      `**Trader**: ${traderDisplay}`,
      `**Asset**: ${alert.asset} ${sideEmoji}`,
      `**Size**: ${formatAmount(alert.size)}`,
      `**Price**: $${alert.price ? formatAmount(alert.price) : 'N/A'}`,
      `**Notional**: $${alert.notionalValue ? formatAmount(alert.notionalValue) : 'N/A'}`,
      `${alert.leverage ? `**Leverage**: ${alert.leverage}x` : ''}`,
      `**Time**: ${new Date(alert.blockTime).toISOString().replace('T', ' ').slice(0, 19)} UTC`,
      `**Tx**: [View Details](${this.createHyperliquidExplorerUrl(alert.txHash, alert.address)})`,
    ].filter(line => line !== '').join('\n');

    // 使用简单的文本格式
    const contractPayload = {
      text: messageText,
      username: 'Contract Monitor',
      alert_info: {
        alert_level: alertLevel,
        trader_label: alert.traderLabel || 'Unknown',
        action: actionText,
        asset: alert.asset,
        side: alert.side,
        size: formatAmount(alert.size),
        price: alert.price ? formatAmount(alert.price) : null,
        notional_value: alert.notionalValue ? formatAmount(alert.notionalValue) : null,
        leverage: alert.leverage,
        address: alert.address,
        transaction_hash: alert.txHash
      },
      raw_alert: alert,
      metadata: {
        system: 'hype-contract-monitor',
        version: '1.1.0',
        timestamp_iso: new Date(alert.timestamp).toISOString(),
        action_type: actionText,
        alert_level: alertLevel
      }
    };

    const response = await axios.post(webhookUrl, contractPayload, {
      timeout: this.timeout,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'HYPE-Contract-Monitor/1.1',
      },
    });

    // 检查响应状态
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
  }

  private createHyperliquidExplorerUrl(txHash: string, address: string): string {
    // Hyperliquid 的 explorer 链接格式
    // 由于 txHash 可能不是标准的区块链交易哈希，我们使用用户页面链接
    return `https://app.hyperliquid.xyz/trade/${address}`;
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
