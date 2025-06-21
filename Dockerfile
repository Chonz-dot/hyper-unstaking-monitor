# 使用Node.js 24 Alpine镜像
FROM node:24-alpine

# 设置工作目录
WORKDIR /app

# 安装必要的系统依赖
RUN apk add --no-cache \
    dumb-init \
    curl

# 复制package.json
COPY package.json ./

# 安装生产依赖（不使用ci，直接install）
RUN npm install --only=production && npm cache clean --force

# 复制构建好的dist目录
COPY dist/ ./dist/

# 创建logs目录（因为.dockerignore排除了logs/）
RUN mkdir -p logs

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
