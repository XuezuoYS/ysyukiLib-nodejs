import { HttpRes } from './httpRes.js';

/**
 * @fileoverview 内置可选中间件（opt-in，默认不启用）
 *
 * 用法：`router.use(Middleware.cors()); router.use(Middleware.accessLog());`
 * 或在分组内 `group.use(...)` 只作用于该分组。
 */

/**
 * @typedef {(ctx: any, next: () => Promise<void>) => any} MiddlewareFn 中间件函数签名
 * @typedef {object} CorsOptions 跨域中间件选项（默认开放来源、不携带凭证）
 * @property {string} [origin] 允许的来源，默认 '*'（无凭证时的开放策略）
 * @property {string} [methods] 允许的方法
 * @property {string} [headers] 允许的请求头
 * @property {boolean} [credentials] 是否允许携带凭证；为 true 时必须显式指定非 '*' 的 origin，否则构造时抛错
 * @property {number} [maxAge] 预检结果缓存秒数
 * @property {boolean} [preflight] 是否短路 OPTIONS 预检
 */

/**
 * 内置可选中间件工厂（全静态方法，不调用即不生效）
 *
 * 三者职责：
 * - cors：跨域响应头 + OPTIONS 预检短路（204，不进入处理器）；
 * - accessLog：在响应 `finish` 时输出一行访问日志（状态码取最终值，异常路径同样记录）；
 * - requestId：把请求标识回写到响应头，便于前后端与日志三方关联。
 *
 * 完整约定（各选项默认值与预检行为）见本文件顶部 `@fileoverview` 与 docs/httpServer.md 的「内置中间件」。
 *
 * 常用入口：cors / accessLog / requestId
 */
export class Middleware {
    /**
     * 跨域中间件
     *
     * 默认 `origin: '*'`（不带凭证）。`credentials: true` 时必须显式指定非 `'*'` 的 origin，
     * 否则构造中间件时抛 Error（启动期配置错误），避免"任意站点可携带凭证调用本 API"。
     *
     * @default options = {}
     * @param {CorsOptions} [options] 选项
     * @returns {MiddlewareFn} 中间件
     * @throws {Error} credentials 为 true 但未显式指定非 `'*'` 的 origin
     */
    static cors(options = {}) {
        const {
            methods = 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
            headers = 'Content-Type, Authorization, X-Request-Id',
            credentials = false,
            maxAge = 86400,
            preflight = true,
        } = options;
        const origin = options.origin === undefined || options.origin === '' ? '*' : options.origin;

        if (credentials && origin === '*') {
            throw new Error('credentials: true 时必须显式指定非 "*" 的 origin（避免任意站点携带凭证调用）');
        }

        return async (ctx, next) => {
            ctx.res.setHeader('Access-Control-Allow-Origin', origin);
            if (origin !== '*') {
                appendVary(ctx.res, 'Origin');
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
     * 是否记录由所属 HttpServer 实例的 ServerLogger 等级决定（见 `HttpServer` 的 `logLevel`），
     * 因此不同服务的访问日志等级互不影响。
     *
     * @returns {MiddlewareFn} 中间件
     */
    static accessLog() {
        return async (ctx, next) => {
            const startedAt = Date.now();
            ctx.res.on('finish', () => {
                ctx.logger.access(ctx.res.statusCode, Date.now() - startedAt);
            });
            await next();
        };
    }

    /**
     * 请求标识中间件（回写响应头）
     *
     * @default options = {}
     * @param {object} [options] 选项
     * @param {string} [options.header] 响应头名
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

/**
 * 追加 Vary 值（已含该维度时不重复，避免覆盖宿主/上游已设的 Vary）
 *
 * @param {import('node:http').ServerResponse} res 响应对象
 * @param {string} value 变体维度（如 Origin）
 */
function appendVary(res, value) {
    const current = res.getHeader('Vary');
    const text = current === undefined
        ? ''
        : (Array.isArray(current) ? current.join(', ') : String(current));
    if (text.split(',').some((item) => item.trim().toLowerCase() === value.toLowerCase())) {
        return;
    }
    if (typeof res.appendHeader === 'function') {
        res.appendHeader('Vary', value);
        return;
    }
    res.setHeader('Vary', text === '' ? value : `${text}, ${value}`);
}
