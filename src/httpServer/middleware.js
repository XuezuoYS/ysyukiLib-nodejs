import { HttpRes } from './httpRes.js';
import { ServerLogger } from './serverLogger.js';

/**
 * 内置可选中间件（opt-in，默认不启用）
 *
 * 用法：`router.use(Middleware.cors()); router.use(Middleware.accessLog());`
 * 或在分组内 `group.use(...)` 只作用于该分组。
 *
 * 三者职责：
 * - cors：跨域响应头 + OPTIONS 预检短路（204，不进入处理器）；
 * - accessLog：在响应 `finish` 时输出一行访问日志（状态码取最终值，异常路径同样记录）；
 * - requestId：把请求标识回写到响应头，便于前后端与日志三方关联。
 *
 * @typedef {(ctx: any, next: () => Promise<void>) => any} MiddlewareFn
 * @typedef {object} CorsOptions
 * @property {string} [origin] 允许的来源，默认 '*'
 * @property {string} [methods] 允许的方法
 * @property {string} [headers] 允许的请求头
 * @property {boolean} [credentials] 是否允许携带凭证（true 时按请求 Origin 回显）
 * @property {number} [maxAge] 预检结果缓存秒数
 * @property {boolean} [preflight] 是否短路 OPTIONS 预检
 */
export class Middleware {
    /**
     * 跨域中间件
     *
     * @param {CorsOptions} [options] 选项
     * @default options = {}
     * @returns {MiddlewareFn} 中间件
     */
    static cors(options = {}) {
        const {
            origin = '*',
            methods = 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
            headers = 'Content-Type, Authorization, X-Request-Id',
            credentials = false,
            maxAge = 86400,
            preflight = true,
        } = options;

        return async (ctx, next) => {
            const requestOrigin = ctx.req.headers.origin;
            const allowOrigin = credentials && origin === '*' && requestOrigin !== undefined
                ? requestOrigin
                : origin;

            ctx.res.setHeader('Access-Control-Allow-Origin', allowOrigin);
            if (allowOrigin !== '*') {
                ctx.res.setHeader('Vary', 'Origin');
            }
            if (credentials) {
                ctx.res.setHeader('Access-Control-Allow-Credentials', 'true');
            }

            if (preflight && ctx.method === 'OPTIONS') {
                ctx.res.setHeader('Access-Control-Allow-Methods', methods);
                ctx.res.setHeader('Access-Control-Allow-Headers', headers);
                ctx.res.setHeader('Access-Control-Max-Age', String(maxAge));
                HttpRes.fastResEmpty(204);
                return;
            }

            await next();
        };
    }

    /**
     * 访问日志中间件（响应结束时输出，状态码为最终值）
     *
     * @returns {MiddlewareFn} 中间件
     */
    static accessLog() {
        return async (ctx, next) => {
            const startedAt = Date.now();
            ctx.res.on('finish', () => {
                ServerLogger.access(ctx, ctx.res.statusCode, Date.now() - startedAt);
            });
            await next();
        };
    }

    /**
     * 请求标识中间件（回写响应头）
     *
     * @param {object} [options] 选项
     * @param {string} [options.header] 响应头名
     * @default options = {}
     * @returns {MiddlewareFn} 中间件
     */
    static requestId(options = {}) {
        const header = options.header ?? 'X-Request-Id';
        return async (ctx, next) => {
            ctx.res.setHeader(header, ctx.requestId);
            await next();
        };
    }
}
