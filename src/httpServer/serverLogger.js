import { STATUS_CODES } from 'node:http';

import { Logger } from '../logger.js';

/**
 * @fileoverview 服务器日志（对基础设施 Logger 的 HTTP 场景定制）
 *
 * Logger 属基础设施（`src/logger.js`），负责 stdout + 文件双通道、等级阈值与日期源；
 * ServerLogger 不重复实现落盘，只在 Logger 之上补齐服务器关心的四件事：
 * 1. 请求级子日志：自动附加 service / requestId / method / path，handler 内一行取用；
 * 2. 访问日志：一行输出状态码、耗时、IP 与 UA（accessLog 中间件调用）；
 * 3. 响应状态日志：按状态码首字符分级（1/2/3 → INFO、4/5 → WARN，其它不记），
 *    由响应写出门面 HttpRes 在写出后调用——每条经过该出口的响应各记一行；
 * 4. 生命周期日志：启动、关闭、优雅退出。
 *
 * 配置隔离：**每个 ServerLogger 实例持有自己的子 logger**，服务名与记录等级都随实例，
 * 互不影响，也不影响根 Logger 与其它子 logger。等级阈值语义与 Logger 一致
 * （warn 记 warn+error、info 记全部、error 只记 error）；未显式设置时实时跟随
 * `Logger.defaultLevel`（开发环境 info，否则 warn）。日期源只有 `Logger.now` 一个入口。
 *
 * 常用函数：
 * - new ServerLogger({ serviceName, level })：每个 HttpServer 实例持有一个
 * - logger.request(ctx)：请求级日志
 * - logger.access(ctx, statusCode, durationMs)：访问日志
 * - logger.response(ctx, statusCode)：响应状态日志（按状态码分级）
 * - logger.startup(host, port) / logger.shutdown(signal, durationMs)
 * - logger.error(message, err, fields)：带堆栈的错误日志
 */

/**
 * @typedef {object} ServerLoggerOptions 服务器日志构造选项
 * @property {string} [serviceName] 服务名（进入所有日志字段；空串则不输出该字段）
 * @property {'info'|'warn'|'error'} [options.level] 记录等级；省略时跟随 Logger.defaultLevel
 *
 * @typedef {object} ServerLoggerRequestLog 请求级日志（`ServerLogger#request` 的返回值）
 * @property {(message: string, fields?: Record<string, any>) => void} info 一般信息
 * @property {(message: string, fields?: Record<string, any>) => void} warn 警告
 * @property {(message: string, fields?: Record<string, any>) => void} error 错误
 * @property {(statusCode: number, durationMs: number) => void} access 访问日志（响应结束时调用）
 * @property {(statusCode: number) => void} response 响应状态日志（响应写出后调用；
 *   1/2/3 → INFO、4/5 → WARN，其它前缀不记）
 */

/**
 * 服务器日志器（每个 HttpServer 实例持有一个，服务名与等级随实例）
 *
 * 契约摘要：只补齐 HTTP 场景的记法，落盘与等级阈值一律委托基础设施 Logger；
 * 实例之间的服务名与等级互不影响，也不影响根 Logger；未显式设置等级时实时跟随
 * `Logger.defaultLevel`；日期源只有 `Logger.now` 一个入口。
 *
 * 完整约定（四类日志各自的字段与分级）见本文件顶部 `@fileoverview`。
 *
 * 常用入口：request / access / response / startup / shutdown / error
 */
export class ServerLogger {
    /**
     * 服务名（进入所有日志字段，便于多服务日志汇聚后区分）
     * @type {string}
     */
    #serviceName;

    /**
     * 该实例专属的子 logger（等级独立）
     * @type {import('../logger.js').SubLogger}
     */
    #log;

    /**
     * @default options = {}
     * @param {ServerLoggerOptions} [options] 选项
     */
    constructor(options = {}) {
        this.#serviceName = options.serviceName === undefined ? '' : String(options.serviceName);
        this.#log = Logger.create({ level: options.level });
    }

    /**
     * 当前服务名
     * @returns {string} 服务名
     */
    get serviceName() {
        return this.#serviceName;
    }

    /**
     * 当前记录等级（阈值）
     * @returns {'info'|'warn'|'error'} 等级
     */
    get level() {
        return this.#log.level;
    }

    /**
     * 设置记录等级；传 null 恢复跟随 Logger.defaultLevel
     * @param {'info'|'warn'|'error'|null} level 等级
     */
    set level(level) {
        this.#log.level = level;
    }

    /**
     * 构造请求级日志（自动附加服务名与请求字段）
     *
     * @param {import('./context.js').HttpContext} ctx 请求上下文
     * @returns {ServerLoggerRequestLog} 请求级日志
     */
    request(ctx) {
        const base = this.#base({
            requestId: ctx.requestId,
            method: ctx.method,
            path: ctx.path,
        });
        return {
            info: (message, fields) => this.#log.info(message, { ...base, ...(fields ?? {}) }),
            warn: (message, fields) => this.#log.warn(message, { ...base, ...(fields ?? {}) }),
            error: (message, fields) => this.#log.error(message, { ...base, ...(fields ?? {}) }),
            access: (statusCode, durationMs) => this.access(ctx, statusCode, durationMs),
            response: (statusCode) => this.response(ctx, statusCode),
        };
    }

    /**
     * 输出一行访问日志（是否记录由本实例等级阈值决定）
     *
     * @param {import('./context.js').HttpContext} ctx 请求上下文
     * @param {number} statusCode HTTP 状态码
     * @param {number} durationMs 处理耗时（毫秒）
     */
    access(ctx, statusCode, durationMs) {
        const userAgent = ctx.req.headers['user-agent'];
        const fields = this.#base({
            requestId: ctx.requestId,
            method: ctx.method,
            path: ctx.path,
            status: statusCode,
            ms: Math.round(durationMs),
            ip: clientIp(ctx.req),
            ua: Array.isArray(userAgent) ? userAgent.join(', ') : (userAgent ?? ''),
        });
        this.#log.info('access', fields);
    }

    /**
     * 响应状态日志（由响应写出门面 HttpRes 在写出后调用）
     *
     * 等级按状态码首字符判定：`1` / `2` / `3` 记 INFO，`4` / `5` 记 WARN，其余前缀
     * （如 6xx–9xx 非标准码）不记。判定取字符串首字符而非数值区间，4 位及以上的
     * 自定义码（如 4999）同样按 4xx 处理。
     *
     * 文本格式：`客户端IP 请求方式 响应代码 原始URL status描述`：
     * - 客户端 IP 优先取 `x-forwarded-for` 首值，回退 socket 远端地址；
     * - 请求方式归一为 `GET` / `POST` / `OTHER`；
     * - 原始 URL 取 `req.url` 原文，含查询字符串与 hash，不做路径归一化；
     * - status 描述优先取响应自带的 `statusMessage`，其次标准 reason phrase，
     *   无对应描述时输出 `No status message`。
     *
     * 是否真正记录由本实例等级阈值决定（生产默认 warn：1/2/3 丢弃、4/5 保留）；
     * 本方法只负责"经过写出口的响应"各记一行，不改变任何响应契约。
     *
     * @param {import('./context.js').HttpContext} ctx 请求上下文
     * @param {number} statusCode HTTP 响应状态码
     */
    response(ctx, statusCode) {
        const level = statusLevel(statusCode);
        if (level === null) {
            return;
        }

        const message = `${clientIp(ctx.req)} ${methodLabel(ctx.method)} ${statusCode}`
            + ` ${ctx.req.url ?? ''} ${statusMessage(ctx.res, statusCode)}`;
        const fields = this.#base({
            requestId: ctx.requestId,
            method: ctx.method,
            path: ctx.path,
            status: statusCode,
        });
        if (level === 'warn') {
            this.#log.warn(message, fields);
        } else {
            this.#log.info(message, fields);
        }
    }

    /**
     * 一般信息日志（自动附加服务名）
     *
     * @default fields = {}
     * @param {string} message 日志消息
     * @param {Record<string, any>} [fields] 附加字段
     */
    info(message, fields = {}) {
        this.#log.info(message, this.#base(fields));
    }

    /**
     * 警告日志（自动附加服务名）
     *
     * @default fields = {}
     * @param {string} message 日志消息
     * @param {Record<string, any>} [fields] 附加字段
     */
    warn(message, fields = {}) {
        this.#log.warn(message, this.#base(fields));
    }

    /**
     * 错误日志（Error 对象由 Logger 序列化为 message + stack）
     *
     * @default fields = {}
     * @param {string} message 日志消息
     * @param {any} [err] 错误对象
     * @param {Record<string, any>} [fields] 附加字段
     */
    error(message, err, fields = {}) {
        this.#log.error(message, this.#base({ ...fields, err }));
    }

    /**
     * 服务启动日志
     *
     * @param {string} host 监听地址
     * @param {number} port 监听端口
     */
    startup(host, port) {
        this.#log.info('服务已启动', this.#base({ host, port }));
    }

    /**
     * 服务关闭日志（优雅退出完成）
     *
     * @param {string} signal 触发信号
     * @param {number} durationMs 关闭耗时（毫秒）
     */
    shutdown(signal, durationMs) {
        this.#log.info('服务已关闭', this.#base({ signal, ms: Math.round(durationMs) }));
    }

    /**
     * 附加服务名字段（未配置时原样返回）
     *
     * @param {Record<string, any>} fields 字段
     * @returns {Record<string, any>} 附加服务名后的字段
     */
    #base(fields) {
        return this.#serviceName === ''
            ? fields
            : { service: this.#serviceName, ...fields };
    }
}

/**
 * 客户端 IP（优先 x-forwarded-for 首值，回退 socket 远端地址）
 *
 * @param {import('node:http').IncomingMessage} req 请求对象
 * @returns {string} 客户端 IP（不可得时为空串）
 */
function clientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded === undefined) {
        return req.socket?.remoteAddress ?? '';
    }
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    return String(first).split(',')[0].trim();
}

/**
 * 请求方式归类（GET / POST / OTHER）
 *
 * @param {string} method HTTP 方法
 * @returns {'GET'|'POST'|'OTHER'} 归类结果
 */
function methodLabel(method) {
    const upper = String(method).toUpperCase();
    return upper === 'GET' || upper === 'POST' ? upper : 'OTHER';
}

/**
 * 状态描述（响应自带 statusMessage 优先，其次标准 reason phrase）
 *
 * @param {import('node:http').ServerResponse} res 响应对象
 * @param {number} statusCode 状态码
 * @returns {string} 状态描述；无对应描述时为 'No status message'
 */
function statusMessage(res, statusCode) {
    const explicit = res.statusMessage;
    if (typeof explicit === 'string' && explicit !== '') {
        return explicit;
    }
    return STATUS_CODES[statusCode] ?? 'No status message';
}

/**
 * 状态码对应的记录等级（1/2/3 → info，4/5 → warn，其它前缀不记）
 *
 * 按字符串首字符判定，保留 4 位及以上自定义码（如 4999）按 4xx 处理的可能。
 *
 * @param {number} statusCode 状态码
 * @returns {'info'|'warn'|null} 记录等级；不记时为 null
 */
function statusLevel(statusCode) {
    const first = String(statusCode).charAt(0);
    if (first === '1' || first === '2' || first === '3') {
        return 'info';
    }
    if (first === '4' || first === '5') {
        return 'warn';
    }
    return null;
}
