import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { Config } from './config.js';

/**
 * 自研结构化日志（stdout + 宿主项目内 log/ 文件双通道，不引第三方）
 *
 * 行格式（IDE/日志查看器友好，\t 分隔三段或四段）：
 * `ISO时间(本地时区)\tLEVEL(大写定宽5)\t消息[\t附加字段JSON]`
 * 例：`2026-09-07T01:23:21.787+08:00\tINFO \t服务已启动\t{"host":"127.0.0.1","port":8000}`
 *
 * 消息中的 `\t` / `\r` / `\n` 会被替换为空格（防止一条记录被拆成多行或破坏三段结构）；
 * 附加字段经 JSON 序列化，转义由 JSON.stringify 保证。
 *
 * 配置分层（入口级 / 子 logger 级，互不影响）：
 * - 入口级（仅 Logger 静态成员）：记录日期源 `Logger.now`、日志目录 `Logger.logDir`、
 *   默认等级 `Logger.defaultLevel`（实时求值：开发环境 info，否则 warn）；
 * - 子 logger 级（`Logger.create({ level })` 的返回值）：各自独立的记录等级，
 *   互不影响、也不影响根 Logger；子 logger **不提供**日期与目录配置（日期只能从 Logger 入口改）。
 *
 * 等级阈值语义：设为 warn 记录 warn+error，设为 info 记录全部，设为 error 只记 error；
 * 未显式设置等级的 logger 每次写日志时实时跟随 `Logger.defaultLevel`。
 *
 * 文件落盘：`log/app-YYYY-MM-DD.log`（宿主项目根下，本地日期，每天一个文件；目录缺失自动创建），
 * 跨天时随下一次写入滚动并清理，目录内日期文件最多保留最近 3 天；
 * 文件写入失败不抛错，静默仅保留 stdout 通道。
 *
 * 日志目录默认 Config.resolveFromRoot('log')，可赋值 Logger.logDir 重定向（测试等）。
 *
 * 禁止在业务代码中裸用 `console.log` 打印业务信息。
 *
 * 常用函数：
 * - Logger.create({ level })：创建等级独立的子 logger
 * - Logger.info/warn/error(message, fields)：根 logger（跟随默认等级）
 * - Logger.now / Logger.logDir / Logger.cleanup()：入口级配置与维护
 *
 */

/** 等级序（阈值比较用） */
const LEVEL_ORDER = { info: 20, warn: 30, error: 40 };

/** 日期文件前缀与保留天数 */
const LOG_PREFIX = 'app-';
const KEEP_DAYS = 3;

/**
 * 显式指定的日志目录（null 表示宿主项目根下 log/）
 * @type {string|null}
 */
let logDirOverride = null;

/** 上一次文件写入的本地日期（跨天滚动判定用） */
let lastDate = '';

/**
 * 当前本地日期 YYYY-MM-DD（文件按服务器本地日切分，与业务 date 语义一致）
 *
 * @param {Date} now 当前时间
 * @returns {string} 日期字符串
 */
function localDate(now) {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * 本地时区 ISO 8601 时间戳（如 2026-09-07T01:28:16.670+08:00）
 *
 * 与日志文件日切同为服务器本地口径；带偏移量，可排序、Date.parse 可逆。
 *
 * @param {Date} now 当前时间
 * @returns {string} 本地 ISO 时间戳
 */
function localIso(now) {
    /**
     * @param {number} n 待补零的数值
     * @param {number} [w] 目标位数
     * @default w = 2
     * @returns {string} 补零后的字符串
     */
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const offsetMin = -now.getTimezoneOffset();
    const sign = offsetMin >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMin);
    const shifted = new Date(now.getTime() + offsetMin * 60000);
    return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
        + `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}.${pad(shifted.getUTCMilliseconds(), 3)}`
        + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * 追加一行到当日日志文件；任何文件层错误静默忽略（stdout 通道已输出）
 *
 * 跨日首写：先建目录（缺失时），追加后再清理——使当日新文件计入保留数。
 *
 * @param {string} line 含行尾换行的完整日志行
 * @param {string} date 本地日期
 */
function fileWrite(line, date) {
    try {
        const isNewDay = lastDate !== date;
        if (isNewDay && !existsSync(Logger.logDir)) {
            mkdirSync(Logger.logDir, { recursive: true });
        }
        appendFileSync(join(Logger.logDir, LOG_PREFIX + date + '.log'), line, 'utf8');
        if (isNewDay) {
            Logger.cleanup();
            lastDate = date;
        }
    } catch {
        // 落盘失败不影响请求路径
    }
}

/**
 * 输出一行结构化日志（stdout + 文件双通道）
 *
 * 等级未达阈值时直接返回（不产生任何 I/O）；日期取自 Logger.now（入口级唯一来源）。
 *
 * @param {'info'|'warn'|'error'} threshold 记录等级阈值
 * @param {'info'|'warn'|'error'} level 本条日志等级
 * @param {string} message 日志消息
 * @param {Record<string, any>} [fields] 附加字段（Error 序列化为 message+stack）
 * @default fields = {}
 */
function writeLine(threshold, level, message, fields = {}) {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[threshold]) {
        return;
    }

    const now = Logger.now();

    /** @type {Record<string, any>} */
    const extra = {};
    for (const [key, value] of Object.entries(fields ?? {})) {
        extra[key] = value instanceof Error
            ? { message: value.message, stack: value.stack }
            : value;
    }

    // 行格式：ISO时间(本地时区)\tLEVEL(定宽5)\t消息[\t附加字段JSON]
    const levelText = level.toUpperCase().padEnd(5);
    const text = String(message).replaceAll(/[\r\n\t]/g, ' ');
    let line = `${localIso(now)}\t${levelText}\t${text}`;
    if (Object.keys(extra).length > 0) {
        line += `\t${JSON.stringify(extra)}`;
    }
    line += '\n';

    process.stdout.write(line);
    fileWrite(line, localDate(now));
}

/**
 * 子 logger（等级独立；日期源与输出通道跟随 Logger 入口）
 *
 * 由 `Logger.create({ level })` 创建。等级为阈值语义：
 * warn 记 warn+error，info 记全部，error 只记 error。
 */
export class SubLogger {
    /**
     * 显式设置的等级（null 表示跟随 Logger.defaultLevel，实时求值）
     * @type {'info'|'warn'|'error'|null}
     */
    #level = null;

    /**
     * @param {object} [options] 选项
     * @param {'info'|'warn'|'error'} [options.level] 记录等级；省略时跟随 Logger.defaultLevel
     * @default options = {}
     */
    constructor(options = {}) {
        this.level = options.level ?? null;
    }

    /**
     * 当前记录等级（阈值）
     * @returns {'info'|'warn'|'error'} 等级
     */
    get level() {
        return this.#level ?? Logger.defaultLevel;
    }

    /**
     * 设置记录等级；传 null 恢复跟随 Logger.defaultLevel
     * @param {'info'|'warn'|'error'|null} level 等级
     * @throws {Error} 未知等级
     */
    set level(level) {
        if (level === null || level === undefined) {
            this.#level = null;
            return;
        }
        if (!Object.prototype.hasOwnProperty.call(LEVEL_ORDER, level)) {
            throw new Error(`未知的日志等级：${level}（可用 info / warn / error）`);
        }
        this.#level = level;
    }

    /**
     * 记录 info 级别日志
     * @param {string} message 日志消息
     * @param {Record<string, any>} [fields] 附加字段
     */
    info(message, fields) {
        writeLine(this.level, 'info', message, fields);
    }

    /**
     * 记录 warn 级别日志
     * @param {string} message 日志消息
     * @param {Record<string, any>} [fields] 附加字段
     */
    warn(message, fields) {
        writeLine(this.level, 'warn', message, fields);
    }

    /**
     * 记录 error 级别日志
     * @param {string} message 日志消息
     * @param {Record<string, any>} [fields] 附加字段（Error 对象放入 err 字段）
     */
    error(message, fields) {
        writeLine(this.level, 'error', message, fields);
    }
}

export class Logger {
    /**
     * 时间源（测试可注入固定时钟以驱动跨日滚动）
     *
     * 记录日期仅通过本入口配置，子 logger 不提供日期设置。
     *
     * @returns {Date} 当前时间
     */
    static now = () => new Date();

    /**
     * 日志目录（默认宿主项目根下 log/，随宿主根解析，可显式赋值重定向）
     * @returns {string} 日志目录绝对路径
     */
    static get logDir() {
        return logDirOverride ?? Config.resolveFromRoot('log');
    }

    /**
     * @param {string|null} dir 日志目录
     */
    static set logDir(dir) {
        logDirOverride = dir === null ? null : String(dir);
    }

    /**
     * 默认等级（实时求值：宿主根存在 dev.config.json 即 info，否则 warn）
     *
     * 未显式设置等级的（子）logger 每次写日志时读取本值，因此增删 dev.config.json 即时生效。
     *
     * @returns {'info'|'warn'} 默认等级
     */
    static get defaultLevel() {
        return Config.isDev() ? 'info' : 'warn';
    }

    /**
     * 创建等级独立的子 logger
     *
     * @param {object} [options] 选项
     * @param {'info'|'warn'|'error'} [options.level] 记录等级；省略时跟随 Logger.defaultLevel
     * @default options = {}
     * @returns {SubLogger} 子 logger
     */
    static create(options = {}) {
        return new SubLogger(options);
    }

    /**
     * 清理超出保留数量的旧日期文件（滚动时自动调用，亦可手动调用）
     *
     * 仅匹配 app-YYYY-MM-DD.log 命名，目录内其他文件不受影响；
     * 目录缺失或不可读时静默返回（公开方法，不应因环境状态抛错）。
     */
    static cleanup() {
        /** @type {string[]} */
        let names;
        try {
            names = readdirSync(Logger.logDir);
        } catch {
            return;
        }

        /** @type {string[]} */
        const dated = names
            .filter((name) => new RegExp(`^${LOG_PREFIX}\\d{4}-\\d{2}-\\d{2}\\.log$`).test(name))
            .sort();
        while (dated.length > KEEP_DAYS) {
            rmSync(join(Logger.logDir, dated.shift()), { force: true });
        }
    }

    /**
     * 根 logger：记录 info 级别日志（跟随 Logger.defaultLevel）
     *
     * @param {string} message 日志消息
     * @param {Record<string, any>} [fields] 附加字段
     */
    static info(message, fields) {
        writeLine(Logger.defaultLevel, 'info', message, fields);
    }

    /**
     * 根 logger：记录 warn 级别日志（跟随 Logger.defaultLevel）
     *
     * @param {string} message 日志消息
     * @param {Record<string, any>} [fields] 附加字段
     */
    static warn(message, fields) {
        writeLine(Logger.defaultLevel, 'warn', message, fields);
    }

    /**
     * 根 logger：记录 error 级别日志（跟随 Logger.defaultLevel）
     *
     * @param {string} message 日志消息
     * @param {Record<string, any>} [fields] 附加字段（Error 对象放入 err 字段）
     */
    static error(message, fields) {
        writeLine(Logger.defaultLevel, 'error', message, fields);
    }
}
