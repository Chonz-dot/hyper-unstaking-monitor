#!/bin/bash
# manage.sh - HYPE转账监控系统统一管理脚本

PROJECT_NAME="hyper-unstaking-monitor"
PM2_NAME="hyper-monitor"
COMPOSE_FILE="docker-compose.yml"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# 打印带颜色的消息
print_message() {
    echo -e "${2}${1}${NC}"
}

# 检查Docker和Docker Compose
check_docker() {
    if ! command -v docker &> /dev/null; then
        print_message "❌ Docker 未安装或未启动" $RED
        print_message "请先安装并启动 Docker" $YELLOW
        return 1
    fi
    
    if ! docker info &> /dev/null; then
        print_message "❌ Docker 服务未运行" $RED
        print_message "请启动 Docker 服务" $YELLOW
        return 1
    fi
    
    if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
        print_message "❌ Docker Compose 未安装" $RED
        print_message "请安装 Docker Compose" $YELLOW
        return 1
    fi
    
    return 0
}

# 检查Node.js和npm (用于本地开发)
check_dependencies() {
    if ! command -v node &> /dev/null; then
        print_message "❌ Node.js 未安装" $RED
        exit 1
    fi
    
    if ! command -v npm &> /dev/null; then
        print_message "❌ npm 未安装" $RED
        exit 1
    fi
}

# 安装依赖
install_deps() {
    print_message "📦 安装项目依赖..." $BLUE
    npm install
    if [ $? -eq 0 ]; then
        print_message "✅ 依赖安装成功" $GREEN
    else
        print_message "❌ 依赖安装失败" $RED
        exit 1
    fi
}

# 构建项目
build_project() {
    print_message "🔨 构建项目..." $BLUE
    npm run build
    if [ $? -eq 0 ]; then
        print_message "✅ 项目构建成功" $GREEN
    else
        print_message "❌ 项目构建失败" $RED
        exit 1
    fi
}

# 使用 docker-compose 或 docker compose
get_compose_cmd() {
    if docker compose version &> /dev/null; then
        echo "docker compose"
    else
        echo "docker-compose"
    fi
}

case "$1" in
    "quick")
        print_message "🚀 快速启动生产环境..." $BLUE
        check_docker || exit 1
        
        # 检查是否有pnpm命令
        if command -v pnpm &> /dev/null; then
            PACKAGE_MANAGER="pnpm"
        elif command -v npm &> /dev/null; then
            PACKAGE_MANAGER="npm"
        else
            print_message "❌ 未找到包管理器 (npm/pnpm)" $RED
            exit 1
        fi
        
        print_message "📦 使用 $PACKAGE_MANAGER 构建项目..." $YELLOW
        $PACKAGE_MANAGER install
        if [ $? -ne 0 ]; then
            print_message "❌ 依赖安装失败" $RED
            exit 1
        fi
        
        $PACKAGE_MANAGER run build
        if [ $? -ne 0 ]; then
            print_message "❌ 项目构建失败" $RED
            exit 1
        fi
        
        print_message "🐳 构建 Docker 镜像..." $YELLOW
        COMPOSE_CMD=$(get_compose_cmd)
        $COMPOSE_CMD build hype-monitor
        if [ $? -ne 0 ]; then
            print_message "❌ Docker 镜像构建失败" $RED
            exit 1
        fi
        
        print_message "🚀 启动 Docker 服务..." $YELLOW
        $COMPOSE_CMD up -d hype-monitor
        if [ $? -eq 0 ]; then
            print_message "✅ 快速启动成功！" $GREEN
            print_message "📊 使用 './manage.sh logs' 查看日志" $CYAN
            print_message "📊 使用 './manage.sh status' 查看状态" $CYAN
            
            # 等待服务就绪并显示状态
            print_message "⏳ 等待服务就绪..." $YELLOW
            sleep 5
            ./manage.sh status
        else
            print_message "❌ Docker 服务启动失败" $RED
            exit 1
        fi
        ;;
        
    "dev")
        print_message "🚀 启动开发环境..." $BLUE
        check_dependencies
        
        # 检查是否有node_modules
        if [ ! -d "node_modules" ]; then
            install_deps
        fi
        
        npm run dev
        ;;
        
    "start")
        print_message "🚀 启动生产环境..." $BLUE
        check_dependencies
        
        # 检查是否有node_modules
        if [ ! -d "node_modules" ]; then
            install_deps
        fi
        
        # 检查是否有构建文件
        if [ ! -d "dist" ]; then
            build_project
        fi
        
        npm start
        ;;
        
    "docker:build")
        print_message "🐳 构建 Docker 镜像..." $BLUE
        check_docker || exit 1
        
        COMPOSE_CMD=$(get_compose_cmd)
        $COMPOSE_CMD build --no-cache
        
        if [ $? -eq 0 ]; then
            print_message "✅ Docker 镜像构建成功" $GREEN
        else
            print_message "❌ Docker 镜像构建失败" $RED
            exit 1
        fi
        ;;
        
    "docker:up")
        print_message "🐳 启动 Docker 服务..." $BLUE
        check_docker || exit 1
        
        COMPOSE_CMD=$(get_compose_cmd)
        $COMPOSE_CMD up -d
        
        if [ $? -eq 0 ]; then
            print_message "✅ Docker 服务启动成功" $GREEN
            print_message "📊 使用 './manage.sh docker:logs' 查看日志" $CYAN
            print_message "📊 使用 './manage.sh docker:status' 查看状态" $CYAN
        else
            print_message "❌ Docker 服务启动失败" $RED
            exit 1
        fi
        ;;
        
    "docker:down")
        print_message "🐳 停止 Docker 服务..." $BLUE
        check_docker || exit 1
        
        COMPOSE_CMD=$(get_compose_cmd)
        $COMPOSE_CMD down
        
        if [ $? -eq 0 ]; then
            print_message "✅ Docker 服务已停止" $GREEN
        else
            print_message "❌ 停止 Docker 服务失败" $RED
        fi
        ;;
        
    "docker:restart")
        print_message "🔄 重启 Docker 服务..." $BLUE
        check_docker || exit 1
        
        COMPOSE_CMD=$(get_compose_cmd)
        $COMPOSE_CMD restart
        
        if [ $? -eq 0 ]; then
            print_message "✅ Docker 服务重启成功" $GREEN
        else
            print_message "❌ Docker 服务重启失败" $RED
        fi
        ;;
        
    "docker:logs")
        print_message "📋 查看 Docker 日志..." $BLUE
        check_docker || exit 1
        
        COMPOSE_CMD=$(get_compose_cmd)
        
        if [ -n "$2" ]; then
            # 查看特定服务的日志
            $COMPOSE_CMD logs -f "$2"
        else
            # 查看所有服务的日志
            $COMPOSE_CMD logs -f
        fi
        ;;
        
    "docker:status")
        print_message "📊 查看 Docker 服务状态..." $BLUE
        check_docker || exit 1
        
        COMPOSE_CMD=$(get_compose_cmd)
        $COMPOSE_CMD ps
        
        print_message "\n🔍 详细状态:" $CYAN
        docker ps --filter "name=hype-monitor" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
        ;;
        
    "docker:shell")
        print_message "🐚 进入容器shell..." $BLUE
        check_docker || exit 1
        
        SERVICE_NAME=${2:-hype-monitor-app}
        docker exec -it $SERVICE_NAME /bin/sh
        ;;
        
    "docker:dev")
        print_message "🐳 启动开发环境 Docker 服务..." $BLUE
        check_docker || exit 1
        
        COMPOSE_CMD=$(get_compose_cmd)
        $COMPOSE_CMD --profile dev up -d
        
        if [ $? -eq 0 ]; then
            print_message "✅ 开发环境 Docker 服务启动成功" $GREEN
            print_message "📊 使用 './manage.sh docker:logs hype-monitor-dev' 查看开发日志" $CYAN
        else
            print_message "❌ 开发环境 Docker 服务启动失败" $RED
        fi
        ;;
        
    "docker:prod")
        print_message "🐳 启动生产环境..." $BLUE
        check_docker || exit 1
        
        print_message "🔨 构建最新镜像..." $YELLOW
        COMPOSE_CMD=$(get_compose_cmd)
        $COMPOSE_CMD build
        
        print_message "🚀 启动生产服务..." $YELLOW
        $COMPOSE_CMD up -d hype-monitor redis
        
        if [ $? -eq 0 ]; then
            print_message "✅ 生产环境启动成功" $GREEN
            
            # 等待服务就绪
            print_message "⏳ 等待服务就绪..." $YELLOW
            sleep 10
            
            # 显示状态
            ./manage.sh docker:status
        else
            print_message "❌ 生产环境启动失败" $RED
        fi
        ;;
        
    "docker:clean")
        print_message "🧹 清理 Docker 资源..." $BLUE
        check_docker || exit 1
        
        COMPOSE_CMD=$(get_compose_cmd)
        
        print_message "🛑 停止并删除容器..." $YELLOW
        $COMPOSE_CMD down --volumes --remove-orphans
        
        print_message "🗑️  删除镜像..." $YELLOW
        docker rmi $(docker images | grep hype-monitor | awk '{print $3}') 2>/dev/null || true
        
        print_message "🧽 清理未使用的资源..." $YELLOW
        docker system prune -f
        
        print_message "✅ Docker 清理完成" $GREEN
        ;;
        
    "pm2")
        print_message "🚀 使用PM2启动生产环境..." $BLUE
        check_dependencies
        
        if ! command -v pm2 &> /dev/null; then
            print_message "📦 安装PM2..." $YELLOW
            npm install -g pm2
        fi
        
        if [ ! -d "node_modules" ]; then
            install_deps
        fi
        
        if [ ! -d "dist" ]; then
            build_project
        fi
        
        pm2 start dist/index.js --name $PM2_NAME
        pm2 save
        print_message "✅ PM2启动成功，使用 'pm2 logs $PM2_NAME' 查看日志" $GREEN
        ;;
        
    "restart")
        print_message "🔄 重启服务..." $BLUE
        
        # 检查是否有Docker服务在运行
        if docker ps --filter "name=hype-monitor" --format "{{.Names}}" | grep -q hype-monitor; then
            print_message "🐳 检测到Docker服务，使用Docker重启..." $YELLOW
            ./manage.sh docker:restart
        # 检查是否有PM2进程
        elif command -v pm2 &> /dev/null && pm2 list | grep -q $PM2_NAME; then
            print_message "🔄 使用PM2重启..." $YELLOW
            build_project
            pm2 restart $PM2_NAME
            print_message "✅ PM2重启成功" $GREEN
        else
            print_message "🔄 使用npm重启..." $YELLOW
            build_project
            npm start
        fi
        ;;
        
    "stop")
        print_message "🛑 停止服务..." $BLUE
        
        # 停止Docker服务
        if docker ps --filter "name=hype-monitor" --format "{{.Names}}" | grep -q hype-monitor; then
            print_message "🐳 停止Docker服务..." $YELLOW
            ./manage.sh docker:down
        fi
        
        # 停止PM2服务
        if command -v pm2 &> /dev/null && pm2 list | grep -q $PM2_NAME; then
            print_message "🛑 停止PM2服务..." $YELLOW
            pm2 stop $PM2_NAME
            print_message "✅ PM2服务已停止" $GREEN
        fi
        ;;
        
    "logs")
        print_message "📋 查看日志..." $BLUE
        
        # 优先显示Docker日志
        if docker ps --filter "name=hype-monitor" --format "{{.Names}}" | grep -q hype-monitor; then
            print_message "🐳 显示Docker日志..." $YELLOW
            ./manage.sh docker:logs hype-monitor-app
        elif command -v pm2 &> /dev/null && pm2 list | grep -q $PM2_NAME; then
            pm2 logs $PM2_NAME
        else
            if [ -d "logs" ]; then
                tail -f logs/*.log
            else
                print_message "❌ 未找到日志文件" $RED
            fi
        fi
        ;;
        
    "status")
        print_message "📊 查看服务状态..." $BLUE
        
        # 检查Docker服务
        if docker ps --filter "name=hype-monitor" --format "{{.Names}}" | grep -q hype-monitor; then
            print_message "🐳 Docker服务状态:" $CYAN
            ./manage.sh docker:status
        fi
        
        # 检查PM2服务
        if command -v pm2 &> /dev/null; then
            print_message "\n⚙️  PM2服务状态:" $CYAN
            pm2 list | grep $PM2_NAME || print_message "❌ PM2中未找到服务" $RED
        fi
        
        # 检查端口占用（HYPE监控系统没有HTTP端口，跳过此检查）
        # Docker容器内部通信和Redis端口检查
        if command -v lsof &> /dev/null; then
            REDIS_PORT="6379"
            if lsof -i :$REDIS_PORT > /dev/null 2>&1; then
                print_message "\n✅ Redis端口 $REDIS_PORT 正在使用中" $GREEN
            else
                print_message "\n⚠️  Redis端口 $REDIS_PORT 未被占用" $YELLOW
            fi
        fi
        ;;
        
    "deploy")
        print_message "📦 部署应用..." $BLUE
        
        # Git更新
        if [ -d ".git" ]; then
            print_message "📥 更新代码..." $YELLOW
            git pull
        fi
        
        # Docker部署
        if check_docker 2>/dev/null; then
            print_message "🐳 使用Docker部署..." $YELLOW
            ./manage.sh docker:prod
        else
            # 传统部署
            check_dependencies
            install_deps
            build_project
            
            if command -v pm2 &> /dev/null && pm2 list | grep -q $PM2_NAME; then
                print_message "🔄 重启PM2服务..." $YELLOW
                pm2 restart $PM2_NAME
                print_message "✅ 部署完成" $GREEN
            else
                print_message "⚠️  请手动重启服务" $YELLOW
            fi
        fi
        ;;
        
    "clean")
        print_message "🧹 清理构建文件..." $BLUE
        
        rm -rf dist/
        rm -rf node_modules/
        rm -f logs/*.log
        
        # 如果存在Docker，也清理Docker资源
        if check_docker 2>/dev/null; then
            print_message "🐳 清理Docker资源..." $YELLOW
            ./manage.sh docker:clean
        fi
        
        print_message "✅ 清理完成" $GREEN
        ;;
        
    "install")
        print_message "📦 安装项目..." $BLUE
        check_dependencies
        install_deps
        ;;
        
    "build")
        print_message "🔨 构建项目..." $BLUE
        check_dependencies
        build_project
        ;;
        
    "test")
        print_message "🧪 运行测试..." $BLUE
        if [ -d "tests" ]; then
            npm test
        else
            print_message "⚠️  未找到测试目录" $YELLOW
            
            # 运行简单的健康检查
            if docker ps --filter "name=hype-monitor" --format "{{.Names}}" | grep -q hype-monitor; then
                print_message "🐳 测试Docker服务健康状态..." $CYAN
                docker exec hype-monitor-app node -e "console.log('✅ 应用运行正常')"
            fi
        fi
        ;;
        
    *)
        print_message "HYPE转账监控系统 - 管理脚本" $BLUE
        echo ""
        print_message "用法: ./manage.sh {command}" $YELLOW
        echo ""
        print_message "🚀 快速命令:" $PURPLE
        echo "  quick          - 快速启动 (pnpm build + docker 一键启动)"
        echo ""
        print_message "🐳 Docker 命令:" $CYAN
        echo "  docker:build   - 构建Docker镜像"
        echo "  docker:up      - 启动Docker服务"
        echo "  docker:down    - 停止Docker服务"  
        echo "  docker:restart - 重启Docker服务"
        echo "  docker:logs    - 查看Docker日志"
        echo "  docker:status  - 查看Docker状态"
        echo "  docker:shell   - 进入容器shell"
        echo "  docker:dev     - 启动开发环境"
        echo "  docker:prod    - 启动生产环境"
        echo "  docker:clean   - 清理Docker资源"
        echo ""
        print_message "⚙️  传统命令:" $GREEN
        echo "  dev      - 启动开发环境"
        echo "  start    - 启动生产环境 (npm)"
        echo "  pm2      - 使用PM2启动生产环境"
        echo "  restart  - 重启服务"
        echo "  stop     - 停止服务"
        echo "  logs     - 查看日志"
        echo "  status   - 查看服务状态"
        echo "  deploy   - 部署应用"
        echo "  clean    - 清理构建文件"
        echo "  install  - 安装依赖"
        echo "  build    - 构建项目"
        echo "  test     - 运行测试"
        echo ""
        print_message "🚀 推荐快速启动:" $PURPLE
        echo "  ./manage.sh quick          # 一键快速启动 (推荐)"
        echo "  ./manage.sh logs           # 查看日志"
        echo "  ./manage.sh status         # 查看状态"
        echo "  ./manage.sh stop           # 停止服务"
        echo ""
        print_message "示例:" $YELLOW
        echo "  ./manage.sh quick          # 快速启动生产环境"
        echo "  ./manage.sh logs           # 查看实时日志"
        echo "  ./manage.sh restart        # 重启服务"
        exit 1
        ;;
esac