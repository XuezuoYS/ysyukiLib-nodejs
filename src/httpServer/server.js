import http from 'node:http';
import { randomUUID } from 'node:crypto';

import { AppError } from './appError.js';
import { runWithContext } from './context.js';
import { JsonRes } from './jsonRes.js';
import { compose } from './onion.js';
import { ServerLogger } from './serverLogger.js';

/**
 * 入站 HTTP 服务入口（轻量框架的装配层）
 *
 * 职责：
 * 1. 建立请求上下文（AsyncLocalStorage），使 HttpReq / JsonRes 一行式可用；
 * 2. 解析请求体（大小上限 + 非法 JSON 直接 400）；
 * 3. 路由匹配与中间件洋葱（全局 + 分组 + 路由级 + 处理器）；
 * 4. 唯一兜底出口，共五条分支：
 *    - 404 未命中：`{name, error: '404 not found', path, method}`；
 *    - 405 方法不符：同形状 `{name, error: '405 method not allowed', path, method}` + `Allow` 头；
 *    - AppError：`{status: message}`，状态码取 `statusCode`；
 *    - 未捕获异常：记 error 日志（堆栈只进日志），输出 500 `{status: '服务器内部错误'}`；
 *    - 响应已开始后发生异常：只记日志，不重复写出。
 * 5. 超时与优雅关闭（SIGINT/SIGTERM → 停止接收新连接 → 空闲连接回收）。
 *
 * 处理器返回值：非 undefined 即自动经 JsonRes.jsonRes 序列化为 JSON 200；
 * 未产生任何输出时补一个空 200（`emptyResponse: false` 可关闭）。
 *
 * 签名约定：
 * - 处理器 `(params, ctx) => any`：params 为已按类型转换的路径参数，ctx 为请求上下文；
 * - 中间件 `(ctx, next) => any`：`await next()` 前后分别为请求前后处理。
 *
 * HEAD 请求：命中 GET 路由，响应头照常写出、响应体自动抑制。
 *
 * @typedef {object} HttpServerOptions
 * @property {import('./router.js').Router} router 路由器（必填）
 * @property {string} [serviceName] 服务名（404/405 响应体 name 字段与日志字段）
 * @property {string} [host] 默认监听地址
 * @property {number} [port] 默认监听端口
 * @property {number} [bodyLimit] 请求体大小上限（字节）
 * @property {number} [headersTimeout] 请求头接收超时（毫秒）
 * @property {number} [requestTimeout] 请求整体超时（毫秒）
 * @property {number} [keepAliveTimeout] 长连接空闲超时（毫秒）
 * @property {boolean} [emptyResponse] 处理器无输出时补空 200
 * @property {boolean} [gracefulShutdown] 监听 SIGINT/SIGTERM 做优雅关闭
 * @property {boolean} [exitOnShutdown] 优雅关闭完成后是否结束进程
 * @property {number} [shutdownTimeout] 强制退出前的等待上限（毫秒）
 * @property {(err: any, ctx: import('./context.js').HttpContext) => void} [onError] 异常钩子（含 AppError）
 */

/** 默认请求体上限：1 MB */
const DEFAULT_BODY_LIMIT = 1024 * 1024;

/** 默认服务名（404/405 响应体 name 字段） */
const DEFAULT_SERVICE_NAME = 'http-server';

/**
 * 路径标准化
 *
 * 请求路径归一化：补齐首斜杠、折叠重复斜杠、剥离尾部斜杠；解码由 URL/decodeURI 原生处理。
 *
 * @param {string} rawPath 原始请求路径（URL pathname）
 * @returns {string} 标准化后的匹配路径（根路径为 ''）
 */
export function normalizePath(rawPath) {
    let path = rawPath;
    try {
        path = decodeURI(path);
    } catch {
        // 非法百分号编码序列：保持原样交由路由匹配（通常落到 404）
    }
    if (!path.startsWith('/')) {
        path = '/' + path;
    }
    if (!path.endsWith('/')) {
        path += '/';
    }
    path = path.replaceAll('//', '/');
    return path.replace(/\/+$/, '');
}

/**
 * 解析请求目标（origin-form / absolute-form）为路径与查询串
 *
 * 注意：不能用 `new URL(req.url, base)` 一步解析——当路径以 `//` 开头时会被
 * 按协议相对 URL 解析（`//health` → host=health），语义错误；仅对代理
 * absolute-form（`http(s)://...` 开头）使用 URL 原生解析。
 *
 * @param {string} rawUrl 原始请求目标（req.url）
 * @returns {{pathname: string, searchParams: URLSearchParams}} 路径与查询参数
 */
export function parseRequestTarget(rawUrl) {
    if (/^https?:\/\//i.test(rawUrl)) {
        const url = new URL(rawUrl);
        return { pathname: url.pathname, searchParams: url.searchParams };
    }

    const queryIndex = rawUrl.indexOf('?');
    const pathname = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
    const search = queryIndex === -1 ? '' : rawUrl.slice(queryIndex + 1);
    return { pathname, searchParams: new URLSearchParams(search) };
}

/**
 * 解析 JSON 请求体
 *
 * 空体/纯空白：空对象；解析失败：400 `参数错误`（不再静默当空对象）；
 * 合法但非对象/数组的标量：空对象（字段读取时按缺失处理）。
 *
 * @param {string} rawBody 请求体原文
 * @returns {Record<string, any>} 已解析请求体
 * @throws {AppError} 请求体非法 JSON
 */
export function parseJsonBody(rawBody) {
    if (rawBody.trim() === '') {
        return {};
    }

    /** @type {any} */
    let decoded;
    try {
        decoded = JSON.parse(rawBody);
    } catch {
        throw new AppError('参数错误', 400);
    }

    return decoded !== null && typeof decoded === 'object' ? decoded : {};
}

export class HttpServer {
    /**
     * 选项（已归一化）
     * @type {Required<Omit<HttpServerOptions, 'router'|'onError'>> & {router: import('./router.js').Router, onError: ((err: any, ctx: import('./context.js').HttpContext) => void)|null}}
     */
    #options;

    /**
     * 底层 node:http 服务
     * @type {import('node:http').Server|null}
     */
    #server = null;

    /**
     * 优雅关闭是否已安装
     * @type {boolean}
     */
    #signalsInstalled = false;

    /**
     * @param {HttpServerOptions} options 选项
     */
    constructor(options) {
        if (options === undefined || options.router === undefined) {
            throw new Error('HttpServer 需要传入 router');
        }

        this.#options = {
            router: options.router,
            serviceName: options.serviceName ?? DEFAULT_SERVICE_NAME,
            host: options.host ?? '127.0.0.1',
            port: options.port ?? 8000,
            bodyLimit: options.bodyLimit ?? DEFAULT_BODY_LIMIT,
            headersTimeout: options.headersTimeout ?? 60_000,
            requestTimeout: options.requestTimeout ?? 300_000,
            keepAliveTimeout: options.keepAliveTimeout ?? 5_000,
            emptyResponse: options.emptyResponse ?? true,
            gracefulShutdown: options.gracefulShutdown ?? true,
            exitOnShutdown: options.exitOnShutdown ?? true,
            shutdownTimeout: options.shutdownTimeout ?? 10_000,
            onError: options.onError ?? null,
        };

        ServerLogger.configure({ serviceName: this.#options.serviceName });
    }

    /**
     * 创建服务实例
     *
     * @param {HttpServerOptions} options 选项
     * @returns {HttpServer} 实例
     */
    static create(options) {
        return new HttpServer(options);
    }

    /**
     * 当前实际监听端口（listen(0) 后为系统分配端口）
     * @returns {number} 端口
     */
    get port() {
        const address = this.#server?.address();
        return address !== null && typeof address === 'object' ? address.port : this.#options.port;
    }

    /**
     * 启动监听
     *
     * @param {number} [port] 端口（省略用构造选项；0 表示系统分配）
     * @param {string} [host] 监听地址
     * @param {() => void} [callback] 监听成功回调
     * @returns {HttpServer} 自身（可链式调用）
     */
    listen(port = this.#options.port, host = this.#options.host, callback = undefined) {
        if (this.#server !== null) {
            throw new Error('服务已启动');
        }

        const server = http.createServer((req, res) => {
            void this.#handle(req, res);
        });

        server.headersTimeout = this.#options.headersTimeout;
        server.requestTimeout = this.#options.requestTimeout;
        server.keepAliveTimeout = this.#options.keepAliveTimeout;
        server.maxHeadersCount = 200;

        this.#server = server;
        server.listen(port, host, () => {
            ServerLogger.startup(host, this.port);
            callback?.();
        });

        if (this.#options.gracefulShutdown) {
            this.#installSignalHandlers();
        }

        return this;
    }

    /**
     * 关闭服务（等待进行中的请求结束）
     *
     * @returns {Promise<void>} 关闭完成
     */
    async close() {
        const server = this.#server;
        if (server === null) {
            return;
        }
        this.#server = null;
        await new Promise((resolve, reject) => {
            server.close((err) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(undefined);
            });
            server.closeIdleConnections();
        });
    }

    /**
     * 安装 SIGINT/SIGTERM 优雅关闭
     */
    #installSignalHandlers() {
        if (this.#signalsInstalled) {
            return;
        }
        this.#signalsInstalled = true;

        for (const signal of ['SIGINT', 'SIGTERM']) {
            process.once(signal, () => {
                const startedAt = Date.now();
                ServerLogger.info('收到退出信号，开始优雅关闭', { signal });
                const timer = setTimeout(() => {
                    ServerLogger.warn('优雅关闭超时，强制退出', { signal, ms: Date.now() - startedAt });
                    if (this.#options.exitOnShutdown) {
                        process.exit(1);
                    }
                }, this.#options.shutdownTimeout);
                timer.unref();

                void this.close().then(() => {
                    clearTimeout(timer);
                    ServerLogger.shutdown(signal, Date.now() - startedAt);
                    if (this.#options.exitOnShutdown) {
                        process.exit(0);
                    }
                });
            });
        }
    }

    /**
     * 单请求处理主流程
     *
     * @param {import('node:http').IncomingMessage} req 请求对象
     * @param {import('node:http').ServerResponse} res 响应对象
     * @returns {Promise<void>}
     */
    async #handle(req, res) {
        const method = String(req.method ?? 'GET').toUpperCase();
        let path = '/';
        let query = new URLSearchParams();
        try {
            const target = parseRequestTarget(req.url ?? '/');
            path = normalizePath(target.pathname);
            query = target.searchParams;
        } catch {
            // 无法解析的请求目标：按根路径处理（通常落到 404）
        }

        const requestId = headerValue(req.headers['x-request-id']) || randomUUID();
        /** @type {import('./context.js').HttpContext} */
        const ctx = {
            req,
            res,
            method,
            path,
            params: {},
            query,
            body: {},
            rawBody: '',
            requestId,
            state: {},
            logger: null,
        };
        ctx.logger = ServerLogger.request(ctx);

        try {
            ctx.rawBody = await this.#readBody(req, method);
            ctx.body = parseJsonBody(ctx.rawBody);

            const match = this.#options.router.match(path, method);
            if (match.status === 'notFound') {
                await runWithContext(ctx, () => this.#writeNotFound(ctx));
                return;
            }
            if (match.status === 'methodNotAllowed') {
                await runWithContext(ctx, () => this.#writeMethodNotAllowed(ctx, match.allowed));
                return;
            }

            ctx.params = match.params;
            const handler = match.target;

            await runWithContext(ctx, async () => {
                await compose([
                    ...this.#options.router.globalMiddleware,
                    ...match.middleware,
                    async (current) => {
                        const result = await handler(current.params, current);
                        if (result !== undefined && !current.res.headersSent && !current.res.writableEnded) {
                            JsonRes.jsonRes(result);
                        }
                    },
                ])(ctx);

                if (this.#options.emptyResponse && !res.headersSent && !res.writableEnded) {
                    JsonRes.fastResEmpty();
                }
            });
        } catch (err) {
            await runWithContext(ctx, () => this.#handleError(err, ctx));
        }
    }

    /**
     * 读取请求体原始文本（含大小上限）
     *
     * GET / HEAD 不读体；超出上限抛 413。
     *
     * @param {import('node:http').IncomingMessage} req 请求对象
     * @param {string} method 请求方法
     * @returns {Promise<string>} 请求体文本
     */
    async #readBody(req, method) {
        if (method === 'GET' || method === 'HEAD') {
            return '';
        }

        /** @type {Buffer[]} */
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
            const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
            size += buffer.length;
            if (size > this.#options.bodyLimit) {
                throw new AppError('请求体过大', 413);
            }
            chunks.push(buffer);
        }
        return Buffer.concat(chunks).toString('utf8');
    }

    /**
     * 404 契约体（维持既有形状）
     *
     * @param {import('./context.js').HttpContext} ctx 请求上下文
     */
    #writeNotFound(ctx) {
        JsonRes.jsonRes({
            name: this.#options.serviceName,
            error: '404 not found',
            path: ctx.path,
            method: ctx.method,
        }, 404);
    }

    /**
     * 405 契约体 + Allow 头（维持既有形状）
     *
     * @param {import('./context.js').HttpContext} ctx 请求上下文
     * @param {string[]} allowed 允许的方法
     */
    #writeMethodNotAllowed(ctx, allowed) {
        JsonRes.header('Allow', allowed.join(', '));
        JsonRes.jsonRes({
            name: this.#options.serviceName,
            error: '405 method not allowed',
            path: ctx.path,
            method: ctx.method,
        }, 405);
    }

    /**
     * 唯一兜底出口
     *
     * @param {any} err 异常
     * @param {import('./context.js').HttpContext} ctx 请求上下文
     */
    #handleError(err, ctx) {
        if (this.#options.onError !== null) {
            try {
                this.#options.onError(err, ctx);
            } catch {
                // 钩子自身异常不得影响兜底输出
            }
        }

        if (ctx.res.headersSent || ctx.res.writableEnded) {
            ServerLogger.error('响应已开始后发生异常', err, { path: ctx.path, method: ctx.method, requestId: ctx.requestId });
            return;
        }

        if (err instanceof AppError) {
            JsonRes.jsonRes({ status: err.message }, err.statusCode);
            return;
        }

        ServerLogger.error('服务器内部错误', err, { path: ctx.path, method: ctx.method, requestId: ctx.requestId });
        JsonRes.jsonRes({ status: '服务器内部错误' }, 500);
    }
}

/**
 * 取头部值（多值时取首个）
 *
 * @param {string|string[]|undefined} value 头部值
 * @returns {string} 字符串值
 */
function headerValue(value) {
    if (Array.isArray(value)) {
        return value[0] ?? '';
    }
    return value ?? '';
}
