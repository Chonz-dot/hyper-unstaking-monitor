(): Promise<boolean> {
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
