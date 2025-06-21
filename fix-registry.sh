#!/bin/bash
# fix-registry.sh - 修复npm镜像源问题

print_message() {
    echo -e "\033[0;32m$1\033[0m"
}

print_error() {
    echo -e "\033[0;31m$1\033[0m"
}

print_warning() {
    echo -e "\033[1;33m$1\033[0m"
}

print_message "🔧 修复npm镜像源问题..."

# 1. 检查当前镜像源
print_message "📋 当前npm配置:"
npm config get registry
pnpm config get registry 2>/dev/null || echo "pnpm未安装"

# 2. 清理缓存
print_message "🧹 清理npm和pnpm缓存..."
npm cache clean --force
pnpm store prune 2>/dev/null || true

# 3. 设置为官方镜像源
print_message "🌍 设置为npm官方镜像源..."
npm config set registry https://registry.npmjs.org/
pnpm config set registry https://registry.npmjs.org/ 2>/dev/null || true

# 4. 删除lock文件，重新安装
print_message "🗑️ 删除lock文件..."
rm -f package-lock.json
rm -f pnpm-lock.yaml
rm -rf node_modules

# 5. 重新安装依赖
print_message "📦 使用官方源重新安装依赖..."
if command -v pnpm &> /dev/null; then
    pnpm install
else
    npm install
fi

if [ $? -eq 0 ]; then
    print_message "✅ 依赖安装成功！"
    print_message "💡 如果之后还有问题，可以运行："
    echo "   npm config set registry https://registry.npmjs.org/"
    echo "   或使用代理: npm config set proxy http://your-proxy:port"
else
    print_error "❌ 依赖安装仍然失败"
    print_warning "🔍 可能的解决方案："
    echo "1. 检查网络连接是否正常"
    echo "2. 尝试使用VPN或代理"
    echo "3. 使用其他镜像源:"
    echo "   npm config set registry https://registry.npmmirror.com/"
    echo "   npm config set registry https://r.cnpmjs.org/"
    echo "4. 如果在企业网络环境，可能需要配置代理:"
    echo "   npm config set proxy http://proxy.company.com:8080"
    echo "   npm config set https-proxy http://proxy.company.com:8080"
fi
