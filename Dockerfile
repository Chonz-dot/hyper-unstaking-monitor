# 使用Node.js 24 Alpine镜像
FROM node:24-alpine

# 设置工作目录
WORKDIR /app

# 安装必要的系统依赖
RUN apk add --no-cache \
    dumb-init \
    curl

# 复制package文件
COPY package*.json ./

# 安装所有依赖（包括开发依赖，用于构建）
RUN npm ci && npm cache clean --force

# 复制源代码
COPY . .

# 构建TypeScript
RUN npm run build

# 删除开发依赖，只保留生产依赖
RUN npm prune --production

# 创建非root用户
RUN addgroup -g 1001 -S nodejs && \
    adduser -S hype-monitor -u 1001 && \
    chown -R hype-monitor:nodejs /app

# 切换到非root用户
USER hype-monitor

# 暴露端口（如果需要）
EXPOSE 3000

# 健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "process.exit(0)" || exit 1

# 使用dumb-init作为PID 1
ENTRYPOINT ["dumb-init", "--"]

# 启动应用
CMD ["node", "dist/index.js"]
