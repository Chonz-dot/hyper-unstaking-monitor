/**
 * Node.js兼容性polyfill
 * 为Node.js v20.12.0提供Promise.withResolvers支持
 * 注意：Promise.withResolvers实际需要Node.js v22+才原生支持
 */

// 检查并添加Promise.withResolvers polyfill
if (!(Promise as any).withResolvers) {
    (Promise as any).withResolvers = function <T>() {
        let resolve: (value: T | PromiseLike<T>) => void;
        let reject: (reason?: any) => void;
        
        const promise = new Promise<T>((res, rej) => {
            resolve = res;
            reject = rej;
        });
        
        return { promise, resolve: resolve!, reject: reject! };
    };
}

// 导出空对象，这个文件只是为了执行polyfill
export {};