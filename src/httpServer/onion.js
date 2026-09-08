/**
 * 中间件洋葱组合（无第三方依赖）
 *
 * 中间件签名：`(ctx, next) => Promise<void>|void`；
 * `await next()` 之前的代码在处理器之前执行，之后的代码在处理器之后执行（洋葱模型）。
 * 同一个中间件重复调用 `next()` 会立即抛错，避免请求被处理两次。
 *
 * @typedef {(ctx: any, next: () => Promise<void>) => any} Middleware
 */

/**
 * 将中间件数组组合为一个可执行函数
 *
 * @param {Middleware[]} middlewares 中间件数组（按注册顺序）
 * @returns {(ctx: any) => Promise<void>} 组合后的执行函数
 */
export function compose(middlewares) {
    return async function run(ctx) {
        let lastIndex = -1;

        /**
         * 执行第 index 个中间件
         * @param {number} index 下标
         * @returns {Promise<void>}
         */
        const dispatch = async (index) => {
            if (index <= lastIndex) {
                throw new Error('next() 被重复调用');
            }
            lastIndex = index;
            const middleware = middlewares[index];
            if (middleware === undefined) {
                return;
            }
            await middleware(ctx, () => dispatch(index + 1));
        };

        await dispatch(0);
    };
}
