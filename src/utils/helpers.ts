export function formatHypeAmount(amount: string | number): string {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(num);
}

export function parseHypeAmount(amount: string): number {
  return parseFloat(amount.replace(/,/g, ''));
}

export function isValidHypeAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

export function truncateHash(hash: string, start = 6, end = 4): string {
  if (hash.length <= start + end) return hash;
  return `${hash.substring(0, start)}...${hash.substring(hash.length - end)}`;
}

export function getTimestampDifference(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
  return `${Math.floor(diff / 86400000)}天前`;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function retry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  delay = 1000
): Promise<T> {
  return new Promise(async (resolve, reject) => {
    let lastError: Error;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await fn();
        resolve(result);
        return;
      } catch (error) {
        lastError = error as Error;
        if (attempt === maxAttempts) break;
        await sleep(delay * attempt);
      }
    }

    reject(lastError!);
  });
}

export function safeParseJson<T>(jsonString: string, defaultValue: T): T {
  try {
    return JSON.parse(jsonString);
  } catch {
    return defaultValue;
  }
}

export function createRateLimiter(maxCalls: number, windowMs: number) {
  const calls: number[] = [];

  return {
    canMakeCall(): boolean {
      const now = Date.now();
      const windowStart = now - windowMs;

      // 清理过期的调用记录
      while (calls.length > 0 && calls[0] < windowStart) {
        calls.shift();
      }

      if (calls.length < maxCalls) {
        calls.push(now);
        return true;
      }

      return false;
    },
    getRemainingCalls(): number {
      const now = Date.now();
      const windowStart = now - windowMs;

      // 清理过期的调用记录
      while (calls.length > 0 && calls[0] < windowStart) {
        calls.shift();
      }

      return Math.max(0, maxCalls - calls.length);
    },
  };
}
