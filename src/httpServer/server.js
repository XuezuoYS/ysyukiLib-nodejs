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
 *    按 Content-Type 选择解析器：`application/x-www-form-urlencoded` 走 parseFormBody，
 *    其余（含缺失）走 parseJsonBody；两者都只产出普通对象，HttpReq.getPostData 写法一致；
 * 3. 中间件洋葱与路由分发（顺序：全局中间件 → 路由决策 → 分组/路由级中间件 → 处理器）；
 *    全局中间件**先于**路由决策执行，因此 404 / 405 也经过它（CORS 预检、全局鉴权、
 *    访问日志得以覆盖未命中与方法不符的请求；预检不再被 405 提前拒掉）；
 * 4. 唯一兜底出口，共五条分支：
 *    - 404 未命中：`{name, error: '404 not found', path, method}`；
 *    - 405 方法不符：同形状 `{name, error: '405 method not allowed', path, method}` + `Allow` 头；
 *    - AppError：`{status: message}`，状态码取 `statusCode`；
 *      路由决策层的"路径命中但 `int` / `float` 参数值超出可精确表示范围"也走这条出口（400）；
 *    - 未捕获异常：记 error 日志（堆栈只进日志），输出 500 `{status: '服务器内部错误'}`；
 *    - 响应已开始后发生异常：只记日志，并 destroy 响应（客户端立即收到连接中断，
 *      不会挂起等待；状态码已无法改动）。
 * 5. 超时与优雅关闭：SIGINT/SIGTERM 由**进程级共享注册表**统一处理（每进程只装一组监听器，
 *    listen 时注册、close 时注销），一次信号关闭全部已注册实例；到 shutdownTimeout 强制断开
 *    剩余连接；仅当所有已注册实例 exitOnShutdown 均为 true 时才结束进程（默认 false，交回宿主）。
 *
 * 处理器返回值：非 undefined 即自动经 HttpRes.jsonRes 序列化为 JSON 200；
 * 未产生任何输出时补一个空 200（`emptyResponse: false` 可关闭）。
 * 补空属文档化的正常路径，不记日志；只有整条链没走到处理器——即某个中间件既没
 * `await next()` 也没写响应——才记 WARN（这类短路最难排查，不能让空 200 静默吞掉）。
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
 * 请求路径归一化：补齐首斜杠、折叠连续斜杠（两个及以上）、剥离尾部斜杠；
 * 解码由 URL/decodeURI 原生处理。
 *
 * 折叠用 `\/{2,}` 而非逐个替换 `//`：`//a///b/` 这类路径只替换一次会残留 `//`，
 * 与 `/a/b` 归一化结果不一致，导致同一路由对"多写斜杠的请求"时而命中时而 404。
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
    path = path.replace(/\/{2,}/g, '/');
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

/**
 * 解析 `application/x-www-form-urlencoded` 请求体
 *
 * 与 `URLSearchParams` 同语义（`+` 视作空格、百分号解码、非法编码原样保留，不抛错）：
 * 同名键取**首个**值（与 `HttpReq.getQuery` 的取值语义一致，避免同一键在两种来源下行为分叉）；
 * 空体/纯空白：空对象；无 `=` 的片段（如 `flag`）按空串值收录。
 *
 * 值一律保持字符串：类型转换交给 `HttpReq.getPostData` 按调用方声明的类型完成，
 * 这样 `getPostData('page', 'int')` 在 form 与 JSON 两种来源下写法一致。
 *
 * @param {string} rawBody 请求体原文
 * @returns {Record<string, string>} 已解析请求体（值均为字符串）
 */
export function parseFormBody(rawBody) {
    if (rawBody.trim() === '') {
        return {};
    }

    /** @type {Record<string, string>} */
    const body = {};
    for (const [key, value] of new URLSearchParams(rawBody)) {
        if (!Object.prototype.hasOwnProperty.call(body, key)) {
            body[key] = value;
        }
    }
    return body;
}

/**
 * 判断 Content-Type 是否为 `application/x-www-form-urlencoded`（忽略大小写与参数）
 *
 * @param {string|string[]|undefined} contentType Content-Type 头原文
 * @returns {boolean} 是否表单编码
 */
function isFormContentType(contentType) {
    const raw = Array.isArray(contentType) ? contentType[0] : contentType;
    if (typeof raw !== 'string') {
        return false;
    }
    const mime = raw.split(';')[0].trim().toLowerCase();
    return mime === 'application/x-www-form-urlencoded';
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
     * @default port = this.#options.port, host = this.#options.host, callback = undefined
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
        const isForm = isFormContentType(req.headers['content-type']);
        /** @type {import('./context.js').HttpContext} */
        const ctx = {
            req,
            res,
            method,
            path,
            params: {},
            query,
            body: {},
            bodySource: isForm ? 'form' : 'json',
            rawBody: '',
            requestId,
            state: {},
            logger: null,
        };
        ctx.logger = this.#logger.request(ctx);

        try {
            ctx.rawBody = await this.#readBody(req, method);
            ctx.body = isForm ? parseFormBody(ctx.rawBody) : parseJsonBody(ctx.rawBody);

            await runWithContext(ctx, async () => {
                // 全局中间件先于路由决策执行：CORS 预检 / 全局鉴权 / 访问日志等需要
                // 覆盖未命中与方法不符的请求（否则预检会先被 405 拒掉，跨域请求直接失败）。
                await compose([
                    ...this.#options.router.globalMiddleware,
                    (current) => this.#dispatch(current, res),
                ])(ctx);

                // 整条链跑完仍没有任何输出：两种成因必须区分开。
                // ① 处理器已被派发执行、只是没产生输出——`emptyResponse` 文档化的正常路径，静默补空即可；
                // ② 某个中间件（全局 / 分组 / 路由级）既没 `await next()` 也没写响应，
                //    处理器根本没跑到（ctx.dispatched 从未置位）——静默补空 200 会让前端
                //    "拿到 200 空体"、后端完全无感知，最难排查，必须告警。
                // 主动写出响应的短路中间件（如 CORS 预检）已在 ctx.responded 标记，两种都不进。
                const unwritten = ctx.responded !== true && !res.headersSent && !res.writableEnded;
                if (unwritten) {
                    if (ctx.dispatched !== true) {
                        ctx.logger.warn(
                            this.#options.emptyResponse
                                ? '中间件未调用 next() 且未写出响应，已补空 200'
                                : '中间件未调用 next() 且未写出响应（emptyResponse 已关闭，未补空响应）',
                            { path: ctx.path },
                        );
                    }
                    if (this.#options.emptyResponse) {
                        HttpRes.fastResEmpty();
                    }
                }
            });
        } catch (err) {
            await runWithContext(ctx, () => this.#handleError(err, ctx));
        }
    }

    /**
     * 路由决策与分发（全局中间件链的末端）
     *
     * 未命中 → 404；方法不符 → 405（带 `Allow`）；路径命中但 `int` / `float` 参数值超出
     * 可精确表示范围 → 400（经 AppError 出口，消息只含参数名与类型，不回显 URL 原文）；
     * 命中 → 分组/路由级中间件 + 处理器。
     * 404 / 405 也经由本方法写出，因此全局中间件已先行执行（预检、鉴权、访问日志均覆盖）。
     * 处理器执行前会置 `ctx.dispatched = true`，入口据此判定"没写出响应"是真短路还是处理器无输出。
     *
     * @param {import('./context.js').HttpContext} ctx 请求上下文
     * @param {import('node:http').ServerResponse} res 响应对象
     * @returns {Promise<void>}
     */
    async #dispatch(ctx, res) {
        const match = this.#options.router.match(ctx.path, ctx.method);

        if (match.status === 'notFound') {
            this.#writeNotFound(ctx);
            return;
        }
        if (match.status === 'methodNotAllowed') {
            this.#writeMethodNotAllowed(ctx, match.allowed);
            return;
        }
        if (match.status === 'badParam') {
            // badParam 由路由层保证非空；判空既满足 checkJs 收窄，也兜住手写 RouteMatch 的调用方
            const bad = match.badParam;
            throw new AppError(
                bad === null ? '路径参数非法' : `路径参数 ${bad.name} 不是合法的 ${bad.type}`,
                400,
            );
        }

        ctx.params = match.params;
        const handler = match.target;

        await compose([
            ...match.middleware,
            async (current) => {
                // 标记处理器已派发执行：处理器无输出是文档化的正常路径（入口静默补空 200），
                // 不该被误判为"中间件漏调 next()"；分组/路由级中间件漏调 next() 时本函数
                // 不会执行，入口据此告警。
                current.dispatched = true;
                const result = await handler(current.params, current);
                if (result !== undefined && !current.res.headersSent && !current.res.writableEnded) {
                    HttpRes.jsonRes(result);
                }
            },
        ])(ctx);
    }

    /**
     * 读取请求体原始文本（含大小上限）
     *
     * GET / HEAD 不读体；超出上限抛 413。
     *
     * 超限后仍把剩余数据读掉（只是不再累积，内存上限不变），再抛出 413：
     * 这样连接状态是干净的，keep-alive 连接可以继续承载下一个请求。
     * 反之（超限即抛、剩余体留在连接里）客户端复用该连接的下一个请求会直接
     * ECONNRESET——调用方看到的是"服务端莫名断连"。
     *
     * @param {import('node:http').IncomingMessage} req 请求对象
     * @param {string} method 请求方法
     * @returns {Promise<string>} 请求体文本
     * @throws {AppError} 请求体超过上限（413）
     */
    #readBody(req, method) {
        if (method === 'GET' || method === 'HEAD') {
            return Promise.resolve('');
        }

        const limit = this.#options.bodyLimit;

        return new Promise((resolve, reject) => {
            /** @type {Buffer[]} */
            const chunks = [];
            let size = 0;
            let exceeded = false;

            req.on('data', (chunk) => {
                if (exceeded) {
                    return; // 已超限：只把剩余数据读掉，不再累积
                }
                const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
                size += buffer.length;
                if (size > limit) {
                    exceeded = true;
                    chunks.length = 0; // 立即释放已累积的请求体
                    return;
                }
                chunks.push(buffer);
            });
            req.on('end', () => {
                if (exceeded) {
                    reject(new AppError('请求体过大', 413));
                    return;
                }
                resolve(Buffer.concat(chunks).toString('utf8'));
            });
            req.on('error', reject);
            req.on('aborted', () => reject(new AppError('请求体读取中断', 400)));
        });
    }

    /**
     * 404 契约体（`{name, error, path, method}`，对外契约勿改形状）
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
     * 405 契约体 + `Allow` 头（形状同 404，对外契约勿改）
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
