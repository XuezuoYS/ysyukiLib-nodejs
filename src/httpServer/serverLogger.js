import { Logger } from '../logger.js';

/**
 * 服务器日志（对基础设施 Logger 的 HTTP 场景定制）
 *
 * Logger 属基础设施（`src/logger.js`），负责 stdout + 文件双通道、等级阈值与日期源；
 * ServerLogger 不重复实现落盘，只在 Logger 之上补齐服务器关心的三件事：
 * 1. 请求级子日志：自动附加 service / requestId / method / path，handler 内一行取用；
 * 2. 访问日志：一行输出状态码、耗时、IP 与 UA（accessLog 中间件调用）；
 * 3. 生命周期日志：启动、关闭、优雅退出。
 *
 * 配置隔离：**每个 ServerLogger 实例持有自己的子 logger**，服务名与记录等级都随实例，
 * 互不影响，也不影响根 Logger 与其它子 logger。等级阈值语义与 Logger 一致
 * （warn 记 warn+error、info 记全部、error 只记 error）；未显式设置时实时跟随
 * `Logger.defaultLevel`（开发环境 info，否则 warn）。日期源只有 `Logger.now` 一个入口。
 *
 * @typedef {object} ServerLoggerOptions
 * @property {string} [serviceName] 服务名（进入所有日志字段；空串则不输出该字段）
 * @property {'info'|'warn'|'error'} [options.level] 记录等级；省略时跟随 Logger.defaultLevel
 *
 * @typedef {object} ServerLoggerRequestLog
 * @property {(message: string, fields?: Record<string, any>) => void} info 一般信息
 * @property {(message: string, fields?: Record<string, any>) => void} warn 警告
 * @property {(message: string, fields?: Record<string, any>) => void} error 错误
 * @property {(statusCode: number, durationMs: number) => void} access 访问日志（响应结束时调用）
 *
 * 常用函数：
 * - new ServerLogger({ serviceName, level })：每个 HttpServer 实例持有一个
 * - logger.request(ctx)：请求级日志
 * - logger.access(ctx, statusCode, durationMs)：访问日志
 * - logger.startup(host, port) / logger.shutdown(signal, durationMs)
 * - logger.error(message, err, fields)：带堆栈的错误日志
 *
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
     * @param {ServerLoggerOptions} [options] 选项
     * @default options = {}
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
            ip: ctx.req.headers['x-forwarded-for'] === undefined
                ? (ctx.req.socket?.remoteAddress ?? '')
                : String(ctx.req.headers['x-forwarded-for']).split(',')[0].trim(),
            ua: Array.isArray(userAgent) ? userAgent.join(', ') : (userAgent ?? ''),
        });
        this.#log.info('access', fields);
    }

    /**
     * 一般信息日志（自动附加服务名）
     *
     * @param {string} message 日志消息
     * @param {Record<string, any>} [fields] 附加字段
     * @default fields = {}
     */
    info(message, fields = {}) {
        this.#log.info(message, this.#base(fields));
    }

    /**
     * 警告日志（自动附加服务名）
     *
     * @param {string} message 日志消息
     * @param {Record<string, any>} [fields] 附加字段
     * @default fields = {}
     */
    warn(message, fields = {}) {
        this.#log.warn(message, this.#base(fields));
    }

    /**
     * 错误日志（Error 对象由 Logger 序列化为 message + stack）
     *
     * @param {string} message 日志消息
     * @param {any} [err] 错误对象
     * @param {Record<string, any>} [fields] 附加字段
     * @default fields = {}
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
