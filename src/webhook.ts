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

  async sendContractAlert(alert: ContractWebhookAlert): Promise<void> {
    if (!this.contractWebhookUrl) {
      logger.warn('合约Webhook URL未配置，跳过合约警报发送');
      return;
    }

    // 🔍 调试日志：webhook发送详情
    logger.info('🔍 [调试] 准备发送合约webhook', {
      traderLabel: alert.traderLabel || 'unknown',
      alertType: alert.alertType,
      asset: alert.asset,
      enhanced: (alert as any).enhanced || false,
      hasFormattedMessage: !!(alert as any).formattedMessage,
      webhookType: (alert as any).enhanced ? 'Trading Analysis' : 'Trade Monitor'
    });

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
    const operationType = alert.metadata?.transferType || 'transfer';
    const operationText = isInternalOp ? `${operationType} (Internal)` : 'Blockchain Transaction';
    
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
    // 🔍 检查是否有格式化消息（增强告警或基础告警都可能有）
    const enhancedAlert = alert as any;
    if (enhancedAlert.formattedMessage) {
      const alertType = enhancedAlert.enhanced ? '增强告警' : '基础告警';
      logger.info(`📨 发送${alertType}消息`, {
        trader: alert.traderLabel,
        asset: alert.asset,
        enhanced: enhancedAlert.enhanced || false,
        messageLength: enhancedAlert.formattedMessage.length,
        hasFormattedMessage: true
      });

      // 直接发送格式化消息
      const formattedPayload = {
        text: enhancedAlert.formattedMessage,
        username: enhancedAlert.enhanced ? 'Trading Analysis' : 'Trade Monitor',
        icon_emoji: enhancedAlert.enhanced ? ':microscope:' : ':chart_with_upwards_trend:',
        parseUrls: false
      };

      const response = await axios.post(webhookUrl, formattedPayload, {
        timeout: this.timeout,
        headers: { 'Content-Type': 'application/json' }
      });

      if (response.status >= 400) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return; // 使用格式化消息，直接返回
    }

    // 🔧 原有的基础告警格式化逻辑
    logger.debug('📨 发送基础告警消息', {
      trader: alert.traderLabel,
      asset: alert.asset,
      enhanced: false
    });

    // 确定警报级别和类型 - 更新图标系统
    let alertLevel = 'INFO';

    // 根据动作类型选择专属图标和颜色 - 改进主题化设计
    const getActionInfo = (alertType: string, side: string) => {
      switch (alertType) {
        case 'position_open_long':
          return {
            text: 'Long Position Opened',
            emoji: '🚀', // 火箭表示做多开仓
            username: 'Trading Signal 🐂',
            icon_emoji: ':rocket:',
            color: 0x00C851, // 更鲜艳的绿色
            signal_type: 'LONG ENTRY'
          };
        case 'position_open_short':
          return {
            text: 'Short Position Opened',
            emoji: '🔻', // 下降箭头表示做空开仓
            username: 'Trading Signal 🐻',
            icon_emoji: ':small_red_triangle_down:',
            color: 0xFF4444, // 更鲜艳的红色
            signal_type: 'SHORT ENTRY'
          };
        case 'position_close':
          return {
            text: 'Position Closed',
            emoji: '🎯', // 靶心表示精准平仓
            username: 'Exit Signal 🚪',
            icon_emoji: ':dart:',
            color: 0xFFBB33, // 橙黄色
            signal_type: 'POSITION EXIT'
          };
        case 'position_increase':
          return {
            text: side === 'long' ? 'Long Position Increased' : 'Short Position Increased',
            emoji: side === 'long' ? '📊' : '📉', // 根据方向选择图表
            username: side === 'long' ? 'Scale-In Signal 🐂' : 'Scale-In Signal 🐻',
            icon_emoji: side === 'long' ? ':chart_with_upwards_trend:' : ':chart_with_downwards_trend:',
            color: side === 'long' ? 0x33B5E5 : 0xFF6B35,
            signal_type: side === 'long' ? 'LONG SCALE-IN' : 'SHORT SCALE-IN'
          };
        case 'position_decrease':
          return {
            text: side === 'long' ? 'Long Position Decreased' : 'Short Position Decreased',
            emoji: '⚖️', // 天平表示减仓调整
            username: 'Scale-Out Signal ⚡',
            icon_emoji: ':scales:',
            color: 0x9C27B0, // 紫色
            signal_type: side === 'long' ? 'LONG SCALE-OUT' : 'SHORT SCALE-OUT'
          };
        default:
          return {
            text: 'Position Updated',
            emoji: '⚡',
            username: 'Trading Bot 🤖',
            icon_emoji: ':zap:',
            color: 0xFF9800,
            signal_type: 'POSITION UPDATE'
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

    const sideEmoji = alert.side === 'long' ? '📈' : '📉';

    // 简化交易员显示：合并标签和地址
    const traderDisplay = `${alert.traderLabel || 'Unknown'} (${alert.address.slice(0, 6)}...${alert.address.slice(-4)})`;

    // 检查是否为合并事件
    const isMergedEvent = alert.mergedCount && alert.mergedCount > 1;

    const mergedInfo = isMergedEvent ?
      `Merged: ${alert.mergedCount} trades combined` : '';

    // 🆕 格式化统计信息
    const statsInfo = alert.traderStats ? [
      `📊 **Trading Stats** (${alert.traderStats.monitoringDays} monitoring)`,
      `🎯 **Total Trades**: ${alert.traderStats.totalTrades} | 🏆 **Win Rate**: ${alert.traderStats.winRate}`,
      `💰 **Total P&L**: ${alert.traderStats.totalRealizedPnL} | 📈 **Volume**: ${alert.traderStats.totalVolume}`,
      `🎮 **Performance**: ${alert.traderStats.performance}`
    ].join('\n') : '';

    // 🆕 开仓信息
    const positionInfo = alert.positionInfo ? [
      `💼 **Position Info**`,
      `💵 **Total Notional**: ${alert.positionInfo.totalNotional}`,
      `📍 **Entry Price**: $${alert.positionInfo.entryPrice}`
    ].join('\n') : '';

    // 🆕 平仓盈亏信息
    const pnlInfo = (alert.realizedPnL !== undefined && alert.alertType === 'position_close') ? [
      `💰 **Realized P&L**: ${alert.realizedPnL >= 0 ? '+' : ''}$${alert.realizedPnL.toFixed(2)} ${alert.realizedPnL >= 0 ? '🟢' : '🔴'}`
    ].join('\n') : '';

    // 修复交易哈希链接生成逻辑
    const createTxLink = (txHash: string, address: string) => {
      // 检查是否为真实交易哈希（64字符的有效十六进制且不是全零）
      const isRealTx = txHash &&
        txHash.startsWith('0x') &&
        txHash.length === 66 &&
        !/^0x0+$/.test(txHash) &&
        !txHash.toLowerCase().includes('merged') &&
        !txHash.toLowerCase().includes('hl_tid') &&
        !txHash.toLowerCase().includes('hl_oid');

      if (isRealTx) {
        return `https://app.hyperliquid.xyz/explorer/tx/${txHash}`;
      }
      // 否则链接到用户交易页面
      return `https://app.hyperliquid.xyz/trade/${address}`;
    };

    const txLink = createTxLink(alert.txHash, alert.address);

    // 判断是否应该显示交易哈希链接（使用相同的逻辑）
    const isRealTxHash = alert.txHash &&
      alert.txHash.startsWith('0x') &&
      alert.txHash.length === 66 &&
      !/^0x0+$/.test(alert.txHash) &&
      !alert.txHash.toLowerCase().includes('merged') &&
      !alert.txHash.toLowerCase().includes('hl_tid') &&
      !alert.txHash.toLowerCase().includes('hl_oid');

    // 创建美化的消息格式 - 主题化设计
    const messageLines = [
      `${actionInfo.emoji} **${actionInfo.signal_type}**: ${actionInfo.text}${isMergedEvent ? ' (Merged)' : ''}`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `🎯 **Trader**: ${traderDisplay}`,
      `💰 **Asset**: ${alert.asset} ${sideEmoji}`,
      `📊 **Size**: ${formatTradeSize(alert.size)}${isMergedEvent ? ' (Combined)' : ''}`,
      `💵 **Price**: $${alert.price ? formatPrice(alert.price) : 'N/A'}${isMergedEvent ? ' (Avg)' : ''}`,
      `🏦 **Notional**: $${alert.notionalValue ? formatCurrency(alert.notionalValue) : 'N/A'}`,
      `${alert.leverage ? `⚡ **Leverage**: ${alert.leverage}x` : ''}`,
      `${mergedInfo ? `🔗 **${mergedInfo}**` : ''}`,
      `⏰ **Time**: ${new Date(alert.blockTime * 1000).toISOString().replace('T', ' ').slice(0, 19)} UTC`,
      `🔍 **Tx**: ${txLink}`,
      `${pnlInfo ? `\n${pnlInfo}` : ''}`,
      `${positionInfo ? `\n${positionInfo}` : ''}`,
      `${statsInfo ? `\n${statsInfo}` : ''}`,
    ].filter(line => line !== '' && !line.includes('**:**')).join('\n');

    // 使用Rocket.Chat特定的格式，禁用link preview
    const contractPayload = {
      text: messageLines,
      username: actionInfo.username, // 动态用户名
      icon_emoji: actionInfo.icon_emoji, // 使用Rocket.Chat格式的emoji
      parseUrls: false, // Rocket.Chat特定：禁用URL解析和preview
      attachments: [], // 确保没有附件触发preview
      alert_info: {
        alert_level: alertLevel,
        trader_label: alert.traderLabel || 'Unknown',
        action: actionInfo.text,
        asset: alert.asset,
        side: alert.side,
        size: formatTradeSize(alert.size),
        price: alert.price ? formatPrice(alert.price) : null,
        notional_value: alert.notionalValue ? formatCurrency(alert.notionalValue) : null,
        leverage: alert.leverage,
        address: alert.address,
        transaction_hash: alert.txHash,
        explorer_url: txLink,
        is_real_tx: isRealTxHash,
        is_merged: isMergedEvent,
        merged_count: alert.mergedCount || 1
      },
      raw_alert: alert,
      metadata: {
        system: 'hype-contract-monitor',
        version: '1.4.0',
        timestamp_iso: new Date(alert.timestamp).toISOString(),
        action_type: actionInfo.text,
        alert_level: alertLevel,
        is_merged_event: isMergedEvent,
        disable_preview: true,
        platform: 'rocket_chat'
      }
    };

    const response = await axios.post(webhookUrl, contractPayload, {
      timeout: this.timeout,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'HYPE-Contract-Monitor/1.4',
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
