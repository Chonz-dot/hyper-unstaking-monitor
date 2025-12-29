import axios from 'axios';
import config from './config';
import logger from './logger';
import { WebhookAlert, ContractWebhookAlert } from './types';
import { formatTradeSize, formatPrice, formatCurrency } from './utils/formatters';

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

  async sendContractAlert(alert: ContractWebhookAlert, customWebhookUrl?: string): Promise<void> {
    // 优先使用自定义webhook，否则使用全局配置
    const webhookUrl = customWebhookUrl || this.contractWebhookUrl;
    
    if (!webhookUrl) {
      const traderLabel = alert.traderLabel || 'unknown';
      logger.warn(`合约Webhook URL未配置（trader: ${traderLabel}），跳过合约警报发送`);
      return;
    }

    // 🔍 调试日志：webhook发送详情
    logger.info('🔍 [调试] 准备发送合约webhook', {
      traderLabel: alert.traderLabel || 'unknown',
      alertType: alert.alertType,
      asset: alert.asset,
      enhanced: (alert as any).enhanced || false,
      hasFormattedMessage: !!(alert as any).formattedMessage,
      webhookType: (alert as any).enhanced ? 'Trading Analysis' : 'Trade Monitor',
      usingCustomWebhook: !!customWebhookUrl,
      webhookUrl: webhookUrl.substring(0, 30) + '...' // 只显示前30个字符
    });

    await this.sendWebhook(webhookUrl, alert, 'contract');
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

    // 计算占解锁总量的百分比
    const calculatePercentage = (amount: string, total?: number) => {
      if (!total || total === 0) return '';
      const percentage = (parseFloat(amount) / total) * 100;
      return ` (${percentage.toFixed(4)}% of unlock amount)`;
    };

    // 确定警报级别和类型
    const isTransferIn = alert.alertType.includes('_in');
    const isSingle = alert.alertType.includes('single_');

    // 主题化的警报级别和图标系统 - 与合约风格统一
    let alertLevel = 'LOW';
    let alertEmoji = '💎'; // 钻石表示价值
    let username = 'Token Tracer 💫';
    let signalType = 'FLOW DETECTED';

    // 根据金额和类型确定警报级别和主题
    const amount = parseFloat(alert.amount);
    if (amount >= 100000) {
      alertLevel = 'HIGH';
      alertEmoji = isTransferIn ? '📈' : '📉'; // 流入上涨 vs 流出下跌
      username = isTransferIn ? 'Token Tracer Pro 📈' : 'Token Tracer Pro 📉';
      signalType = isTransferIn ? 'MEGA INFLOW' : 'MEGA OUTFLOW';
    } else if (amount >= 50000) {
      alertLevel = 'MEDIUM';
      alertEmoji = isTransferIn ? '💰' : '💸'; // 资金流入 vs 资金流出
      username = isTransferIn ? 'Token Tracer 💰' : 'Token Tracer 💸';
      signalType = isTransferIn ? 'BIG INFLOW' : 'BIG OUTFLOW';
    } else if (amount >= 10000) {
      alertLevel = 'MEDIUM';
      alertEmoji = isTransferIn ? '📊' : '📋'; // 数据流入 vs 数据流出
      username = isTransferIn ? 'Token Tracer 📊' : 'Token Tracer 📋';
      signalType = isTransferIn ? 'NOTABLE INFLOW' : 'NOTABLE OUTFLOW';
    }

    const actionText = isTransferIn ? 'Transfer In' : 'Transfer Out';
    const thresholdType = isSingle ? 'Large Single' : '24h Cumulative';
    const directionEmoji = isTransferIn ? '📈' : '📉';
    const flowIcon = isTransferIn ? '⬇️' : '⬆️';

    // 为转账添加区块浏览器链接
    const createTransferTxLink = (txHash: string, metadata: any) => {
      // 检查是否是内部操作
      const isInternal = metadata?.isInternalOperation ||
        txHash.startsWith('internal_') ||
        txHash.startsWith('ledger_') ||
        txHash === '0x0000000000000000000000000000000000000000000000000000000000000000';

      if (isInternal) {
        // 对于内部操作，链接到地址页面而不是交易页面
        return `https://app.hyperliquid.xyz/trade/${alert.address}`;
      }

      // 正常交易链接到区块浏览器
      return `https://hypurrscan.io/tx/${txHash}`;
    };

    const transferTxLink = createTransferTxLink(alert.txHash, alert.metadata);

    // 检查是否是内部操作，调整显示文本
    const isInternalOp = alert.metadata?.isInternalOperation ||
      alert.txHash.startsWith('internal_') ||
      alert.txHash.startsWith('ledger_') ||
      alert.txHash === '0x0000000000000000000000000000000000000000000000000000000000000000';

    const txLinkText = isInternalOp ? 'Account Page' : 'Transaction';
    
    // 🆕 优化操作类型显示 - 优先使用具体的transferType，然后是eventType
    let operationType = alert.metadata?.transferType || 'transfer';
    
    // 将技术术语转换为用户友好的显示文本
    const operationDisplayNames: Record<string, string> = {
      'deposit': 'Deposit',
      'withdraw': 'Withdraw', 
      'cStakingTransfer': 'Staking Transfer',
      'spotTransfer': 'Spot Transfer',
      'internalTransfer': 'Internal Transfer',
      'accountClassTransfer': 'Account Transfer',
      'subAccountTransfer': 'Sub-Account Transfer',
      'transfer_in': 'Transfer In',
      'transfer_out': 'Transfer Out',
      'transfer': 'Transfer'
    };
    
    const displayName = operationDisplayNames[operationType] || operationType.charAt(0).toUpperCase() + operationType.slice(1);
    const operationText = isInternalOp ? `${displayName} (Internal)` : displayName;
    
    // 🆕 处理代币信息和价格
    const asset = alert.metadata?.originalAsset || 'HYPE';
    const priceDisplay = alert.priceInfo?.formattedPrice || '';
    const tokenDisplay = priceDisplay ? `${asset} (${priceDisplay})` : asset;
    
    // 🆕 USD价值信息
    const currentUsdValue = alert.priceInfo?.formattedValue || '';
    const cumulativeUsdValue = alert.cumulativePriceInfo?.formattedValue || '';

    // 统一的美化消息格式 - 与合约警报一致的风格
    const messageLines = [
      `${alertEmoji} **${signalType}**: ${thresholdType} ${actionText} ${flowIcon}`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `🌐 **Network**: Hyperliquid`,
      `💰 **Token**: ${tokenDisplay} ${directionEmoji}`,
      `📊 **Amount**: ${formatTradeSize(alert.amount)}${calculatePercentage(alert.amount, alert.unlockAmount)}`,
      `${currentUsdValue ? `💵 **USD Value**: ${currentUsdValue}` : ''}`,
      `🏠 **Address**: ${alert.address.slice(0, 6)}...${alert.address.slice(-4)} (${alert.addressLabel || 'Unknown'})`,
      `${alert.unlockAmount ? `🔓 **Unlock Total**: ${formatTradeSize(alert.unlockAmount.toString())} HYPE` : ''}`,
      `🔗 **${txLinkText}**: ${transferTxLink}`,
      `⚙️ **Operation**: ${operationText}`,
      `⏰ **Time**: ${new Date(alert.blockTime * 1000).toISOString().replace('T', ' ').slice(0, 19)} UTC`,
      `${alert.cumulativeToday ? `📈 **24h Cumulative**: ${formatTradeSize(alert.cumulativeToday)} ${asset}` : ''}`,
      `${cumulativeUsdValue ? `💰 **Cumulative USD**: ${cumulativeUsdValue}` : ''}`,
    ].filter(line => line !== ''); // 过滤空行

    // 优化的 payload，适配主题化设计
    const simplePayload = {
      text: messageLines.join('\n'),
      username: username, // 动态用户名
      icon_emoji: ':whale:', // 鲸鱼图标
      parseUrls: false, // Rocket.Chat特定：禁用URL解析和preview
      attachments: [], // 确保没有附件
      // 保留基本的元数据
      alert_info: {
        alert_level: alertLevel,
        amount: formatTradeSize(alert.amount),
        network: 'Hyperliquid',
        address_label: alert.addressLabel || 'Unknown',
        address: alert.address,
        transaction_hash: alert.txHash,
        unlock_amount: alert.unlockAmount ? formatTradeSize(alert.unlockAmount.toString()) : null,
        percentage: alert.unlockAmount ? ((parseFloat(alert.amount) / alert.unlockAmount) * 100).toFixed(4) + '%' : null,
        cumulative_24h: alert.cumulativeToday ? formatTradeSize(alert.cumulativeToday) : null,
        explorer_link: transferTxLink
      },
      // 原始数据
      raw_alert: alert,
      metadata: {
        system: 'hype-unstaking-monitor',
        version: '1.4.0',
        timestamp_iso: new Date(alert.timestamp).toISOString(),
        action_type: actionText,
        threshold_type: thresholdType,
        alert_level: alertLevel,
        platform: 'rocket_chat'
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
    // 🔍 统一使用格式化消息（所有告警都应该有格式化消息）
    const tradingAlert = alert as any;
    if (tradingAlert.formattedMessage) {
      const alertType = tradingAlert.useAdvancedAnalysis ? '交易分析' : '基础分析';
      logger.info(`📨 发送${alertType}消息`, {
        trader: alert.traderLabel,
        asset: alert.asset,
        useAdvancedAnalysis: tradingAlert.useAdvancedAnalysis || false,
        messageLength: tradingAlert.formattedMessage.length,
        hasFormattedMessage: true
      });

      // 统一发送格式化消息
      const formattedPayload = {
        text: tradingAlert.formattedMessage,
        username: 'Trading Analysis',  // 统一使用 Trading Analysis
        icon_emoji: ':microscope:',    // 统一使用显微镜图标
        parseUrls: false
      };

      const response = await axios.post(webhookUrl, formattedPayload, {
        timeout: this.timeout,
        headers: { 'Content-Type': 'application/json' }
      });

      if (response.status >= 400) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return;
    }

    // 🚨 如果没有格式化消息，说明系统有问题
    logger.error('⚠️ 合约告警缺少格式化消息，这不应该发生', {
      trader: alert.traderLabel,
      asset: alert.asset,
      alertType: alert.alertType
    });
    throw new Error('合约告警必须包含格式化消息');
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
