/**
 * 数字格式化工具
 * 统一处理合约交易警报中的数字显示格式
 */

/**
 * 格式化交易数量/规模 (最多4位小数，移除尾随零，添加千分符)
 */
export function formatTradeSize(amount: string | number): string {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (isNaN(num)) return 'N/A';
  
  // 对于非常小的数值，保留更多小数位
  if (Math.abs(num) < 0.001 && num !== 0) {
    return num.toFixed(8).replace(/\.?0+$/, ''); // 移除尾随零
  }
  
  // 🔧 修复：对于正常交易规模，添加千分符
  const formatted = num.toFixed(4).replace(/\.?0+$/, ''); // 移除尾随零
  const parts = formatted.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ','); // 添加千分符
  return parts.join('.');
}

/**
 * 格式化价格 (2位小数)
 */
export function formatPrice(price: string | number): string {
  const num = typeof price === 'string' ? parseFloat(price) : price;
  if (isNaN(num)) return 'N/A';
  return num.toLocaleString('en-US', { 
    minimumFractionDigits: 2, 
    maximumFractionDigits: 2 
  });
}

/**
 * 格式化货币金额 (智能缩写：K, M, B)
 */
export function formatCurrency(amount: string | number): string {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (isNaN(num)) return 'N/A';
  
  if (Math.abs(num) >= 1000000000) {
    return `${(num / 1000000000).toFixed(2)}B`;
  } else if (Math.abs(num) >= 1000000) {
    return `${(num / 1000000).toFixed(2)}M`;
  } else if (Math.abs(num) >= 1000) {
    return `${(num / 1000).toFixed(1)}K`;
  } else {
    return num.toLocaleString('en-US', { 
      minimumFractionDigits: 0, 
      maximumFractionDigits: 2 
    });
  }
}

/**
 * 格式化变化量 (带符号，最多4位小数)
 */
export function formatChange(change: string | number): string {
  const num = typeof change === 'string' ? parseFloat(change) : change;
  if (isNaN(num)) return 'N/A';
  
  const sign = num >= 0 ? '+' : '-';
  const formatted = formatTradeSize(Math.abs(num));
  return `${sign}${formatted}`;
}

/**
 * 格式化百分比 (2位小数)
 */
export function formatPercentage(value: number): string {
  if (isNaN(value)) return 'N/A';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}
