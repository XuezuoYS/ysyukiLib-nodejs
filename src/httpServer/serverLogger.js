import { Logger } from '../logger.js';

/**
 * 服务器日志包装（对基础设施 Logger 的 HTTP 场景定制）
 *
 * Logger 属基础设施（`src/logger.js`），负责 stdout + 文件双通道与级别门控；
 * ServerLogger 不重复实现落盘，只在 Logger 之上补齐服务器关心的三件事：
 * 1. 请求级子日志：自动附加 service / requestId / method / path，handler 内一行取用；
 * 2. 访问日志：一行输出状态码、耗时、IP 与 UA（accessLog 中间件调用）；
 * 3. 生命周期日志：启动、关闭、优雅退出。
 *
 * 级别门控沿用 Logger 语义（开发环境全级别，非开发环境仅 warn/error）；
 * 访问日志级别可用 `configure({ accessLevel })` 调整，便于生产按需保留。
 *
 * @typedef {object} ServerLoggerRequestLog
 * @property {(message: string, fields?: Record<string, any>) => void} info 一般信息
 * @property {(message: string, fields?: Record<string, any>) => void} warn 警告
 * @property {(message: string, fields?: Record<string, any>) => void} error 错误
 *
 * 常用函数：
 * - ServerLogger.configure({ serviceName, accessLevel })：服务名与访问日志级别
 * - ServerLogger.request(ctx)：请求级日志
 * - ServerLogger.access(ctx, statusCode, durationMs)：访问日志
 * - ServerLogger.startup(host, port) / shutdown(signal, durationMs)
 * - ServerLogger.error(message, err, fields)：带堆栈的错误日志
 *
 */
export class ServerLogger {
    /**
     * 服务名（进入所有日志字段，便于多服务日志汇聚后区分）
     * @type {string}
     */
    static #serviceName = '';

    /**
     * 访问日志级别（info / warn / error）
     * @type {'info'|'warn'|'error'}
     */
    static #accessLevel = 'info';

    /**
     * 配置服务名与访问日志级别
     *
     * @param {object} [options] 配置项
     * @param {string} [options.serviceName] 服务名，空串表示不输出该字段
     * @param {'info'|'warn'|'error'} [options.accessLevel] 访问日志级别
     * @default options = {}
     */
    static configure(options = {}) {
        if (options.serviceName !== undefined) {
            ServerLogger.#serviceName = String(options.serviceName);
        }
        if (options.accessLevel !== undefined) {
            ServerLogger.#accessLevel = options.accessLevel;
        }
    }

    /**
     * 当前服务名
     * @returns {string} 服务名
     */
    static get serviceName() {
        return ServerLogger.#serviceName;
    }

    /**
     * 构造请求级日志（自动附加服务名与请求字段）
     *
     * @param {import('./context.js').HttpContext} ctx 请求上下文
     * @returns {ServerLoggerRequestLog} 请求级日志
     */
    static request(ctx) {
        const base = ServerLogger.#base({
            requestId: ctx.requestId,
            method: ctx.method,
            path: ctx.path,
        });
        return {
            info: (message, fields) => Logger.info(message, { ...base, ...(fields ?? {}) }),
            warn: (message, fields) => Logger.warn(message, { ...base, ...(fields ?? {}) }),
            error: (message, fields) => Logger.error(message, { ...base, ...(fields ?? {}) }),
        };
    }

    /**
     * 输出一行访问日志
     *
     * @param {import('./context.js').HttpContext} ctx 请求上下文
     * @param {number} statusCode HTTP 状态码
     * @param {number} durationMs 处理耗时（毫秒）
     */
    static access(ctx, statusCode, durationMs) {
        const userAgent = ctx.req.headers['user-agent'];
        const fields = ServerLogger.#base({
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
        ServerLogger.#emit(ServerLogger.#accessLevel, 'access', fields);
    }

    /**
     * 一般信息日志（自动附加服务名）
     *
     * @param {string} message 日志消息
     * @param {Record<string, any>} [fields] 附加字段
     * @default fields = {}
     */
    static info(message, fields = {}) {
        Logger.info(message, ServerLogger.#base(fields));
    }

    /**
     * 警告日志（自动附加服务名）
     *
     * @param {string} message 日志消息
     * @param {Record<string, any>} [fields] 附加字段
     * @default fields = {}
     */
    static warn(message, fields = {}) {
        Logger.warn(message, ServerLogger.#base(fields));
    }

    /**
     * 服务启动日志
     *
     * @param {string} host 监听地址
     * @param {number} port 监听端口
     */
    static startup(host, port) {
        Logger.info('服务已启动', ServerLogger.#base({ host, port }));
    }

    /**
     * 服务关闭日志（优雅退出完成）
     *
     * @param {string} signal 触发信号
     * @param {number} durationMs 关闭耗时（毫秒）
     */
    static shutdown(signal, durationMs) {
        Logger.info('服务已关闭', ServerLogger.#base({ signal, ms: Math.round(durationMs) }));
    }

    /**
     * 错误日志（Error 对象由 Logger 序列化为 message + stack）
     *
     * @param {string} message 日志消息
     * @param {any} [err] 错误对象
     * @param {Record<string, any>} [fields] 附加字段
     * @default fields = {}
     */
    static error(message, err, fields = {}) {
        Logger.error(message, ServerLogger.#base({ ...fields, err }));
    }

    /**
     * 附加服务名字段（未配置时原样返回）
     *
     * @param {Record<string, any>} fields 字段
     * @returns {Record<string, any>} 附加服务名后的字段
     */
    static #base(fields) {
        return ServerLogger.#serviceName === ''
            ? fields
            : { service: ServerLogger.#serviceName, ...fields };
    }

    /**
     * 按级别输出（访问日志用）
     *
     * @param {'info'|'warn'|'error'} level 级别
     * @param {string} message 日志消息
     * @param {Record<string, any>} fields 附加字段
     */
    static #emit(level, message, fields) {
        if (level === 'warn') {
            Logger.warn(message, fields);
            return;
        }
        if (level === 'error') {
            Logger.error(message, fields);
            return;
        }
        Logger.info(message, fields);
    }
}
