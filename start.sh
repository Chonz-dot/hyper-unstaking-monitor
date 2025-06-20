#!/bin/bash

# HYPE监控系统启动脚本

set -e

echo "🚀 启动HYPE解锁监控系统..."

# 检查Node.js环境
if ! command -v node &> /dev/null; then
    echo "❌ Node.js未安装，请先安装Node.js"
    exit 1
fi

# 检查Docker环境
if ! command -v docker &> /dev/null; then
    echo "❌ Docker未安装，请先安装Docker"
    exit 1
fi

# 创建日志目录
mkdir -p logs

# 检查.env文件
if [ ! -f .env ]; then
    echo "📝 创建环境配置文件..."
    cp .env.example .env
    echo "⚠️  请编辑 .env 文件，配置您的Webhook URL和其他参数"
    echo "📄 配置文件路径: $(pwd)/.env"
    read -p "按Enter键继续，或Ctrl+C退出进行配置..."
fi

# 安装依赖
if [ ! -d "node_modules" ]; then
    echo "📦 安装项目依赖..."
    npm install
fi

# 启动Redis容器
echo "🗃️  启动Redis服务..."
docker-compose up -d

# 等待Redis启动
echo "⏳ 等待Redis服务启动..."
sleep 3

# 检查Redis连接
echo "🔍 检查Redis连接..."
if docker-compose exec -T redis redis-cli ping > /dev/null 2>&1; then
    echo "✅ Redis连接正常"
else
    echo "❌ Redis连接失败，请检查Docker容器状态"
    docker-compose logs redis
    exit 1
fi

# 构建TypeScript项目
echo "🔨 构建项目..."
npm run build

echo "🎯 启动监控系统..."
echo "📊 系统将监控 26 个HYPE解锁地址"
echo "🚨 预警阈值: 单笔≥10,000 HYPE, 日累计≥50,000 HYPE"
echo "📡 Webhook通知已配置"
echo ""

# 启动监控
npm start
