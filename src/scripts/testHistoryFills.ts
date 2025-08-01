#!/usr/bin/env node

/**
 * 历史成交数据测试脚本
 * 用于验证监控逻辑是否正确捕获历史交易
 */

// Node.js兼容性polyfill
import '../polyfills';

import * as hl from '@nktkas/hyperliquid';
import logger from '../logger';
import config from '../config';

interface HistoryTestConfig {
    // 测试时间范围（小时）
    hoursBack: number;
    // 要测试的地址列表
    addresses: string[];
    // 最小交易金额阈值
    minNotionalValue: number;
    // 是否显示详细日志
    verbose: boolean;
}

class HistoryFillsTester {
    private infoClient: hl.InfoClient;
    private config: HistoryTestConfig;

    constructor(testConfig: HistoryTestConfig) {
        this.config = testConfig;
        
        // 初始化Hyperliquid客户端
        const transport = new hl.HttpTransport({
            timeout: 30000,
            isTestnet: false,
        });
        this.infoClient = new hl.InfoClient({ transport });
    }

    /**
     * 运行历史数据测试
     */
    async runTest(): Promise<void> {
        logger.info('🧪 开始历史成交数据测试', {
            hoursBack: this.config.hoursBack,
            addresses: this.config.addresses.length,
            minNotionalValue: this.config.minNotionalValue
        });

        const endTime = Date.now();
        const startTime = endTime - (this.config.hoursBack * 60 * 60 * 1000);

        logger.info('📅 测试时间范围', {
            startTime: new Date(startTime).toISOString(),
            endTime: new Date(endTime).toISOString(),
            timeRangeHours: this.config.hoursBack
        });

        let totalFills = 0;
        let validFills = 0;
        const addressResults: Array<{
            address: string;
            label: string;
            fillsCount: number;
            validFillsCount: number;
            totalNotional: number;
            fills: any[];
        }> = [];

        // 测试每个地址
        for (const traderConfig of config.contractMonitoring.traders) {
            if (!traderConfig.isActive || !this.config.addresses.includes(traderConfig.address)) {
                continue;
            }

            logger.info(`🔍 测试地址: ${traderConfig.label}`, {
                address: traderConfig.address
            });

            try {
                // 查询历史填充数据
                const requestParams = {
                    user: traderConfig.address as `0x${string}`,
                    startTime: startTime,  // 保持毫秒时间戳
                    endTime: endTime       // 保持毫秒时间戳
                };

                logger.info(`📤 API请求参数`, {
                    address: traderConfig.address,
                    startTime: requestParams.startTime,
                    endTime: requestParams.endTime,
                    startTimeISO: new Date(startTime).toISOString(),
                    endTimeISO: new Date(endTime).toISOString()
                });

                const fills = await this.infoClient.userFillsByTime(requestParams);

                logger.info(`📥 API响应`, {
                    address: traderConfig.address,
                    fillsLength: fills?.length || 0,
                    fillsType: typeof fills,
                    isArray: Array.isArray(fills)
                });

                totalFills += fills?.length || 0;
                
                const validFillsForAddress: any[] = [];
                let totalNotionalForAddress = 0;

                if (fills && fills.length > 0) {
                    logger.info(`📊 ${traderConfig.label} 原始数据`, {
                        rawFillsCount: fills.length,
                        sampleFills: fills.slice(0, 2)
                    });

                    // 分析每个填充
                    for (const fill of fills) {
                        const notionalValue = this.calculateNotionalValue(fill);
                        const isValid = this.validateFill(fill, notionalValue);
                        
                        if (isValid) {
                            validFills++;
                            validFillsForAddress.push({
                                ...fill,
                                notionalValue,
                                timestamp: new Date(fill.time).toISOString()
                            });
                            totalNotionalForAddress += notionalValue;
                        }

                        if (this.config.verbose) {
                            logger.info(`📝 Fill详情`, {
                                time: new Date(fill.time).toISOString(),
                                coin: fill.coin,
                                side: fill.side,
                                sz: fill.sz,
                                px: fill.px,
                                notionalValue,
                                isValid,
                                hash: fill.hash
                            });
                        }
                    }
                } else {
                    logger.info(`📭 ${traderConfig.label} 无交易数据`);
                }

                addressResults.push({
                    address: traderConfig.address,
                    label: traderConfig.label,
                    fillsCount: fills?.length || 0,
                    validFillsCount: validFillsForAddress.length,
                    totalNotional: totalNotionalForAddress,
                    fills: validFillsForAddress
                });

            } catch (error) {
                logger.error(`❌ ${traderConfig.label} 查询失败`, {
                    error: error instanceof Error ? error.message : error,
                    address: traderConfig.address
                });
            }
        }

        // 输出测试结果
        this.printTestResults(addressResults, totalFills, validFills);
    }

    /**
     * 计算交易的名义价值
     */
    private calculateNotionalValue(fill: any): number {
        const size = parseFloat(fill.sz);
        const price = parseFloat(fill.px);
        return size * price;
    }

    /**
     * 验证填充是否符合监控条件
     */
    private validateFill(fill: any, notionalValue: number): boolean {
        // 应用与监控系统相同的过滤逻辑
        if (notionalValue < this.config.minNotionalValue) {
            return false;
        }

        // 可以添加其他验证条件
        return true;
    }

    /**
     * 打印测试结果
     */
    private printTestResults(results: any[], totalFills: number, validFills: number): void {
        logger.info('📋 历史数据测试结果摘要', {
            totalAddressesTested: results.length,
            totalRawFills: totalFills,
            totalValidFills: validFills,
            filterRate: totalFills > 0 ? `${((validFills / totalFills) * 100).toFixed(2)}%` : '0%'
        });

        // 详细结果
        for (const result of results) {
            if (result.validFillsCount > 0) {
                logger.info(`🎯 ${result.label} 有效交易`, {
                    address: result.address,
                    rawFills: result.fillsCount,
                    validFills: result.validFillsCount,
                    totalNotional: `$${result.totalNotional.toFixed(2)}`,
                    avgNotional: result.validFillsCount > 0 ? `$${(result.totalNotional / result.validFillsCount).toFixed(2)}` : '$0'
                });

                // 显示前3个重要交易
                const topFills = result.fills
                    .sort((a: any, b: any) => b.notionalValue - a.notionalValue)
                    .slice(0, 3);

                for (const fill of topFills) {
                    logger.info(`💰 重要交易`, {
                        time: fill.timestamp,
                        asset: fill.coin,
                        side: fill.side,
                        size: fill.sz,
                        price: `$${parseFloat(fill.px).toFixed(4)}`,
                        notional: `$${fill.notionalValue.toFixed(2)}`,
                        hash: fill.hash
                    });
                }
            } else {
                logger.info(`📭 ${result.label} 无有效交易`, {
                    address: result.address,
                    rawFills: result.fillsCount
                });
            }
        }

        // 检查特定的SOL交易
        this.checkForSpecificTrades(results);
    }

    /**
     * 检查是否包含特定的已知交易
     */
    private checkForSpecificTrades(results: any[]): void {
        logger.info('🔍 检查特定交易');
        
        // 查找Jul 31, 5:32-5:33 AM的SOL交易
        const targetTime = new Date('2025-07-31T05:33:08Z').getTime(); // 更精确的时间
        const timeWindow = 10 * 60 * 1000; // 10分钟窗口

        for (const result of results) {
            if (result.address === '0xb8b9e3097c8b1dddf9c5ea9d48a7ebeaf09d67d2') {
                const solTrades = result.fills.filter((fill: any) => {
                    const fillTime = new Date(fill.timestamp).getTime();
                    return fill.coin === 'SOL' && 
                           Math.abs(fillTime - targetTime) < timeWindow;
                });

                if (solTrades.length > 0) {
                    logger.info('✅ 找到目标SOL交易！', {
                        count: solTrades.length,
                        trades: solTrades
                    });
                } else {
                    logger.warn('❌ 未找到目标SOL交易', {
                        address: result.address,
                        targetTime: new Date(targetTime).toISOString(),
                        totalFills: result.fills.length
                    });
                }
            }
        }
    }
}

/**
 * 主函数
 */
async function main(): Promise<void> {
    const testConfig: HistoryTestConfig = {
        hoursBack: 24, // 恢复到24小时
        addresses: [
            '0xfa6af5f4f7440ce389a1e650991eea45c161e13e', // 交易员1
            '0xa04a4b7b7c37dbd271fdc57618e9cb9836b250bf', // 交易员2
            '0xb8b9e3097c8b1dddf9c5ea9d48a7ebeaf09d67d2', // 交易员3 (SOL交易地址)
            '0xd5ff5491f6f3c80438e02c281726757baf4d1070', // 交易员4
            '0x31ca8395cf837de08b24da3f660e77761dfb974b'  // test
        ],
        minNotionalValue: 100, // 与监控系统相同的阈值
        verbose: process.argv.includes('--verbose') || process.argv.includes('-v')
    };

    const tester = new HistoryFillsTester(testConfig);
    
    try {
        await tester.runTest();
        logger.info('✅ 历史数据测试完成');
    } catch (error) {
        logger.error('❌ 测试失败', {
            error: error instanceof Error ? error.message : error
        });
        process.exit(1);
    }
}

// 如果直接运行此脚本
if (require.main === module) {
    main().catch(console.error);
}

export default HistoryFillsTester;