import winston from 'winston';
import config from './config';

// 创建日志格式
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// 控制台格式
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ level, message, timestamp, ...meta }) => {
    let msg = `${timestamp} [${level}]: ${message}`;
    if (Object.keys(meta).length > 0) {
      msg += ` ${JSON.stringify(meta)}`;
    }
    return msg;
  })
);

// 创建传输器数组
const transports: winston.transport[] = [
  new winston.transports.Console({
    format: consoleFormat,
    level: config.logging.level,
  }),
];

// 如果配置了日志文件，添加文件传输器
if (config.logging.file) {
  transports.push(
    new winston.transports.File({
      filename: config.logging.file,
      format: logFormat,
      level: config.logging.level,
    })
  );
}
// 创建logger实例
export const logger = winston.createLogger({
  level: config.logging.level,
  format: logFormat,
  transports,
  // 防止未捕获的异常崩溃进程
  exceptionHandlers: [
    new winston.transports.Console({ format: consoleFormat }),
  ],
  rejectionHandlers: [
    new winston.transports.Console({ format: consoleFormat }),
  ],
  exitOnError: false,
});

export default logger;
