import http from 'node:http';
import { randomUUID } from 'node:crypto';

import { AppError } from './appError.js';
import { Logger } from '../logger.js';
import { runWithContext } from './context.js';
import { HttpRes } from './httpRes.js';
import { compose } from './onion.js';
import { ServerLogger } from './serverLogger.js';

/**
 * 入站 HTTP 服务入口（轻量框架的装配层）
 *
 * 职责：
 * 1. 建立请求上下文（AsyncLocalStorage），使 HttpReq / HttpRes 一行式可用；
 * 2. 解析请求体（大小上限 + 非法 JSON 直接 400）；
 * 3. 路由匹配与中间件洋葱（全局 + 分组 + 路由级 + 处理器）；
 * 4. 唯一兜底出口，共五条分支：
 *    - 404 未命中：`{name, error: '404 not found', path, method}`；
 *    - 405 方法不符：同形状 `{name, error: '405 method not allowed', path, method}` + `Allow` 头；
 *    - AppError：`{status: message}`，状态码取 `statusCode`；
 *    - 未捕获异常：记 error 日志（堆栈只进日志），输出 500 `{status: '服务器内部错误'}`；
 *    - 响应已开始后发生异常：只记日志，并 destroy 响应（客户端立即收到连接中断，
 *      不会挂起等待；状态码已无法改动）。
 * 5. 超时与优雅关闭：SIGINT/SIGTERM 由**进程级共享注册表**统一处理（每进程只装一组监听器，
 *    listen 时注册、close 时注销），一次信号关闭全部已注册实例；到 shutdownTimeout 强制断开
 *    剩余连接；仅当所有已注册实例 exitOnShutdown 均为 true 时才结束进程（默认 false，交回宿主）。
 *
 * 处理器返回值：非 undefined 即自动经 HttpRes.jsonRes 序列化为 JSON 200；
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
 * @property {boolean} [gracefulShutdown] 注册到进程级信号注册表，收到 SIGINT/SIGTERM 时优雅关闭
 * @property {boolean} [exitOnShutdown] 优雅关闭完成后是否结束进程；仅当所有已注册实例均为 true 才 process.exit
 * @property {number} [shutdownTimeout] 关闭超时（毫秒）：到点强制断开剩余连接
 * @property {'info'|'warn'|'error'} [logLevel] 服务器日志等级（省略时跟随 Logger 默认：开发 info / 生产 warn）
 * @property {(err: any, ctx: import('./context.js').HttpContext) => void} [onError] 异常钩子（含 AppError）
 */

/** 默认请求体上限：1 MB */
const DEFAULT_BODY_LIMIT = 1024 * 1024;

/** 默认服务名（404/405 响应体 name 字段） */
const DEFAULT_SERVICE_NAME = 'http-server';

/** 优雅关闭监听的信号（进程级只装一组监听器，多实例共享） */
const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'];

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
     * @type {Required<Omit<HttpServerOptions, 'router'|'onError'|'logLevel'>> & {router: import('./router.js').Router, logLevel: 'info'|'warn'|'error'|null, onError: ((err: any, ctx: import('./context.js').HttpContext) => void)|null}}
     */
    #options;

    /**
     * 本实例专属的服务器日志（服务名与等级随实例，互不影响）
     * @type {ServerLogger}
     */
    #logger;

    /**
     * 底层 node:http 服务
     * @type {import('node:http').Server|null}
     */
    #server = null;

    /**
     * 进程级优雅关闭注册表（listen 时加入，close 时移出；进程内所有实例共享一组信号监听器）
     * @type {Set<HttpServer>}
     */
    static #shutdownRegistry = new Set();

    /**
     * 当前已安装的进程信号监听器（signal -> handler；注册表为空时清空）
     * @type {Map<string, () => void>}
     */
    static #signalHandlers = new Map();

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
            exitOnShutdown: options.exitOnShutdown ?? false,
            shutdownTimeout: options.shutdownTimeout ?? 10_000,
            logLevel: options.logLevel ?? null,
            onError: options.onError ?? null,
        };

        this.#logger = new ServerLogger({
            serviceName: this.#options.serviceName,
            level: this.#options.logLevel,
        });
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
     * 本实例的服务器日志（可在此调整等级：`server.logger.level = 'info'`）
     * @returns {ServerLogger} 服务器日志
     */
    get logger() {
        return this.#logger;
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
            this.#logger.startup(host, this.port);
            callback?.();
        });

        if (this.#options.gracefulShutdown) {
            HttpServer.#shutdownRegistry.add(this);
            HttpServer.#installSignalHandlers();
        }

        return this;
    }

    /**
     * 关闭服务（等待进行中的请求结束）
     *
     * @returns {Promise<void>} 关闭完成
     */
    async close() {
        // 先从进程级注册表注销：注册表清空后移除信号监听器（已关闭实例不再响应信号）
        HttpServer.#shutdownRegistry.delete(this);
        if (HttpServer.#shutdownRegistry.size === 0) {
            HttpServer.#uninstallSignalHandlers();
        }

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
     * 安装进程级信号监听（注册表从空变为非空时安装一次，同进程多实例共享）
     */
    static #installSignalHandlers() {
        if (HttpServer.#signalHandlers.size > 0) {
            return;
        }
        for (const signal of SHUTDOWN_SIGNALS) {
            const handler = () => {
                void HttpServer.#shutdownAll(signal).catch((err) => {
                    // 关闭流程自身异常不得变成未处理拒绝（会终止进程且无从排查）
                    Logger.error('优雅关闭异常', { err, signal });
                });
            };
            HttpServer.#signalHandlers.set(signal, handler);
            process.once(signal, handler);
        }
    }

    /**
     * 移除进程级信号监听（注册表清空后调用；信号触发时也会先移除，避免重复进入关闭流程）
     */
    static #uninstallSignalHandlers() {
        for (const [signal, handler] of HttpServer.#signalHandlers) {
            process.off(signal, handler);
        }
        HttpServer.#signalHandlers.clear();
    }

    /**
     * 收到退出信号：关闭注册表中的全部实例
     *
     * 到 shutdownTimeout 强制断开剩余连接；仅当所有实例 exitOnShutdown 均为 true 时结束进程。
     *
     * @param {string} signal 触发信号
     * @returns {Promise<void>}
     */
    static async #shutdownAll(signal) {
        HttpServer.#uninstallSignalHandlers();

        const servers = [...HttpServer.#shutdownRegistry];
        if (servers.length === 0) {
            return;
        }

        const startedAt = Date.now();

        // 快照底层服务引用：close() 会先把实例的 #server 置空，
        // 超时回调必须靠这份快照才能强制断开剩余连接
        const targets = servers.map((server) => ({ instance: server, node: server.#server }));

        // 进程级事件（收到信号 / 超时）用首个实例的 logger 记录，附带实例数便于区分
        const processLog = targets[0].instance.#logger;
        processLog.info('收到退出信号，开始优雅关闭', { signal, servers: targets.length });

        // 超时上限取各实例的最大值，避免单个实例的短超时提前掐断其它实例的在途请求
        const timeoutMs = servers.reduce((max, server) => Math.max(max, server.#options.shutdownTimeout), 0);
        let isTimeout = false;
        const timer = setTimeout(() => {
            isTimeout = true;
            processLog.warn('优雅关闭超时，强制断开剩余连接', { signal, ms: Date.now() - startedAt });
            for (const target of targets) {
                target.node?.closeAllConnections();
            }
        }, timeoutMs);
        timer.unref();

        await Promise.all(targets.map((target) => target.instance.close().catch((err) => {
            target.instance.#logger.error('关闭实例失败', err, { signal });
        })));
        clearTimeout(timer);

        const durationMs = Date.now() - startedAt;
        for (const target of targets) {
            target.instance.#logger.shutdown(signal, durationMs);
        }

        // 退出进程需所有实例一致同意（默认 false：交回宿主决定）
        if (servers.every((server) => server.#options.exitOnShutdown)) {
            process.exit(isTimeout ? 1 : 0);
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
        ctx.logger = this.#logger.request(ctx);

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
                            HttpRes.jsonRes(result);
                        }
                    },
                ])(ctx);

                if (this.#options.emptyResponse && !res.headersSent && !res.writableEnded) {
                    HttpRes.fastResEmpty();
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
        HttpRes.jsonRes({
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
        HttpRes.header('Allow', allowed.join(', '));
        HttpRes.jsonRes({
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
            ctx.logger.error('响应已开始后发生异常', { err });
            // 响应头已发出，无法再改成 500；但必须终结这条响应：
            // 只 return 会让客户端一直等一个永远不会到来的结尾（实测挂起不返回），
            // 同时连接与并发槽位被长期占用。destroy() 会让客户端立即收到截断/连接中断，
            // 明确知道请求失败，而不是无限等待。
            ctx.res.destroy();
            return;
        }

        if (err instanceof AppError) {
            HttpRes.jsonRes({ status: err.message }, err.statusCode);
            return;
        }

        ctx.logger.error('服务器内部错误', { err });
        HttpRes.jsonRes({ status: '服务器内部错误' }, 500);
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
