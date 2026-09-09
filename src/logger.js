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
 * **记录日志不抛错**：Logger 常是 catch / onError 的兜底路径，它自己炸掉等于把
 * "记一条日志"变成炸宿主，因此序列化与写通道全程受保护（见 {@link serializeFields}）：
 * - 循环引用、BigInt、超深嵌套、`toJSON` 抛错等不可原生序列化的字段，
 *   降级为 `[Circular]` / `[BigInt 10]` / `[Truncated]` 等可读标记（仍是合法 JSON）；
 * - 连一行文本都构造不出来时，退化为只含时间/等级/消息的兜底行；
 * - stdout 与文件两个通道各自独立失败，任一不可用都不影响另一个，也不影响调用方。
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
 * 滚动状态为「日期 + 目录」两者：跨日、当日重设 `Logger.logDir`、`Config.setRootDir()`
 * 换宿主根，都会在下一写建好目标目录并清理，目录内日期文件最多保留最近 3 天；
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

/** 安全编码器的最大嵌套深度（超出截断，防异常深结构递归爆栈） */
const MAX_FIELD_DEPTH = 10;

/**
 * 显式指定的日志目录（null 表示宿主项目根下 log/）
 * @type {string|null}
 */
let logDirOverride = null;

/** 上一次文件写入的本地日期（跨天滚动判定用） */
let lastDate = '';

/**
 * 上一次文件写入的日志目录
 *
 * 与 `lastDate` 一起构成滚动状态：当日重设 `Logger.logDir`（或 `Config.setRootDir()`
 * 使默认目录随之改变）后，新旧目录不同即视为一次滚动，新目录会在首写时被创建。
 * 只看日期会让"当日换目录"退化成往不存在的目录里追加，静默丢日志直到次日。
 * @type {string}
 */
let lastDir = '';

/**
 * 默认等级缓存（写日志热路径上避免每次同步 stat dev.config.json）
 *
 * path 为缓存的开发配置路径，null 表示尚未求值。
 * @type {{path: string|null, level: 'info'|'warn'}}
 */
const devStatusCache = { path: null, level: 'warn' };

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
 * 取当前时间（`Logger.now` 是宿主可注入项，异常或非法时间退回真实时钟）
 *
 * @returns {Date} 可用的时间
 */
function safeNow() {
    try {
        const now = Logger.now();
        return now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
    } catch {
        return new Date();
    }
}

/**
 * 尽力取文本（宿主传入对象的 `toString` 抛错时不连累日志本身）
 *
 * @param {any} value 任意值
 * @returns {string} 文本；不可转换时为标记
 */
function safeText(value) {
    try {
        return String(value);
    } catch {
        return '[Unstringifiable]';
    }
}

/**
 * 定宽 5 的大写等级文本（`info` → `INFO `）
 *
 * 等级由本库内部给出（三个字面量），这里仍用 safeText 兜一手：
 * 拼行格式的任何一步都不该成为抛错来源。
 *
 * @param {'info'|'warn'|'error'} level 等级
 * @returns {string} 等级文本
 */
function levelText(level) {
    return safeText(level).toUpperCase().padEnd(5);
}

/**
 * 降级标记（合法 JSON 字符串字面量）
 *
 * @param {string} text 标记文本
 * @returns {string} JSON 文本
 */
function mark(text) {
    return JSON.stringify(text);
}

/**
 * 序列化附加字段：**任何输入都不抛错**
 *
 * 快路径为原生 `JSON.stringify`，正常字段的输出与既有行为逐字节一致；
 * 仅当它抛错（循环引用、`BigInt`、超深嵌套、`toJSON` 抛错等）时退化为安全编码器。
 * 日志常是 catch / onError 的兜底路径，"记一条日志"不能反过来炸宿主。
 *
 * @param {Record<string, any>} extra 附加字段
 * @returns {string} JSON 文本
 */
function serializeFields(extra) {
    try {
        const text = JSON.stringify(extra);
        if (typeof text === 'string') {
            return text;
        }
    } catch {
        // 转入安全编码器
    }
    try {
        return encodeSafe(extra, [], 0);
    } catch {
        // 宿主对象把安全编码器也拖垮（Proxy 陷阱抛错等）：只留一条固定标记
        return '{"fieldsUnserializable":"[Unserializable]"}';
    }
}

/**
 * 安全 JSON 编码器（仅在 `JSON.stringify` 抛错时使用）
 *
 * 与原生序列化的差异都是刻意的：不可原生表达的值换成可读标记，输出仍是合法 JSON
 * （下游解析器可直接消费）。循环引用按**祖先链**判定，同层重复引用不会被误伤。
 *
 * @param {any} value 待编码值
 * @param {any[]} path 当前祖先对象链（循环引用判定用）
 * @param {number} depth 当前嵌套深度
 * @returns {string} JSON 文本
 */
function encodeSafe(value, path, depth) {
    switch (typeof value) {
        case 'string':
            return JSON.stringify(value);
        case 'number':
            return Number.isFinite(value) ? String(value) : 'null'; // 与原生一致：NaN / Infinity → null
        case 'boolean':
            return String(value);
        case 'bigint':
            return mark(`[BigInt ${value}]`);
        case 'function':
            return mark(`[Function ${value.name || 'anonymous'}]`);
        case 'symbol':
            return mark(`[Symbol ${safeText(value.description)}]`);
        default:
            break;
    }

    if (value === null || value === undefined) {
        return 'null';
    }
    if (depth >= MAX_FIELD_DEPTH) {
        return mark('[Truncated]');
    }
    if (path.includes(value)) {
        return mark('[Circular]');
    }

    /** @type {any} */
    let target = value;
    if (typeof target.toJSON === 'function') {
        try {
            target = target.toJSON();
        } catch {
            return mark('[ToJSON threw]');
        }
        if (target === null || typeof target !== 'object') {
            return encodeSafe(target, path, depth + 1); // Date 等 toJSON 产出标量
        }
        if (path.includes(target)) {
            return mark('[Circular]');
        }
    }

    /** @type {any[]} */
    const nextPath = [...path, target];
    if (Array.isArray(target)) {
        /** @type {string[]} */
        const items = [];
        for (let i = 0; i < target.length; i += 1) {
            items.push(encodeSafe(target[i], nextPath, depth + 1));
        }
        return `[${items.join(',')}]`;
    }

    /** @type {string[]} */
    const parts = [];
    for (const key of Object.keys(target)) {
        /** @type {any} */
        let child;
        try {
            child = target[key];
        } catch {
            parts.push(`${JSON.stringify(key)}:${mark('[Getter threw]')}`);
            continue;
        }
        if (child === undefined) {
            continue; // 与原生一致：对象上省略 undefined 值
        }
        parts.push(`${JSON.stringify(key)}:${encodeSafe(child, nextPath, depth + 1)}`);
    }
    return `{${parts.join(',')}}`;
}

/**
 * 清理指定目录内超出保留数量的旧日期文件（公开入口见 `Logger.cleanup`）
 *
 * @param {string} dir 日志目录
 */
function cleanupDatedFiles(dir) {
    /** @type {string[]} */
    let names;
    try {
        names = readdirSync(dir);
    } catch {
        return;
    }

    /** @type {string[]} */
    const dated = names
        .filter((name) => new RegExp(`^${LOG_PREFIX}\\d{4}-\\d{2}-\\d{2}\\.log$`).test(name))
        .sort();
    while (dated.length > KEEP_DAYS) {
        const name = /** @type {string} */ (dated.shift());
        try {
            rmSync(join(dir, name), { force: true });
        } catch {
            // 单个旧文件删不掉（Windows 上常见 EBUSY：被编辑器或采集器占用）：
            // 跳过它继续清理更靠后的文件，不让清理失败连累本次写入
        }
    }
}

/**
 * 确保日志目录存在（缺失时递归创建）
 *
 * @param {string} dir 日志目录
 * @returns {boolean} 目录已存在或创建成功返回 true；创建失败（父路径是文件、无权限等）返回 false
 */
function ensureLogDir(dir) {
    try {
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        return true;
    } catch {
        return false;
    }
}

/**
 * 异常是否为"路径上缺目录"（ENOENT / ENOTDIR；Windows 上两种都可能出现）
 *
 * @param {any} err 文件层异常
 * @returns {boolean} 是返回 true
 */
function isMissingDirError(err) {
    const code = err !== null && typeof err === 'object'
        ? /** @type {{ code?: string }} */ (err).code
        : undefined;
    return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * 文件通道实现：滚动判定 → 建目录 → 追加 → 清理
 *
 * 滚动判定含三种情形，任一成立都要先确保目标目录存在：跨日、当日重设 `Logger.logDir`、
 * `Config.setRootDir()` 换宿主根（默认目录随之改变）。只按日期判定会让当日新换的目录
 * 永不被创建，文件通道静默丢日志直到次日。
 * 追加报"缺目录"时（日志目录在运行期被外部删除）补建目录并重试一次。
 * 只有写入成功才推进滚动状态，失败下次仍会重试滚动。
 *
 * @param {string} line 含行尾换行的完整日志行
 * @param {string} date 本地日期
 */
function writeToFile(line, date) {
    const dir = Logger.logDir;
    const file = join(dir, LOG_PREFIX + date + '.log');
    const isRoll = date !== lastDate || dir !== lastDir;

    if (isRoll) {
        ensureLogDir(dir);
    }
    try {
        appendFileSync(file, line, 'utf8');
    } catch (err) {
        if (!isMissingDirError(err)) {
            throw err;
        }
        ensureLogDir(dir);
        appendFileSync(file, line, 'utf8');
    }

    if (isRoll) {
        cleanupDatedFiles(dir);
        lastDate = date;
        lastDir = dir;
    }
}

/**
 * 文件通道入口：吞掉一切文件层错误（stdout 通道已输出，落盘失败不影响请求路径）
 *
 * 滚动、建目录、追加与清理的实际步骤见 {@link writeToFile}。
 *
 * @param {string} line 含行尾换行的完整日志行
 * @param {string} date 本地日期
 */
function fileWrite(line, date) {
    try {
        writeToFile(line, date);
    } catch {
        // 落盘失败静默
    }
}

/**
 * 收集附加字段（逐键读取，属性访问受保护）
 *
 * `Object.entries` 会调用宿主对象的 getter：一个抛错的 getter 就足以连累整条日志
 * （只剩兜底行，其余字段全丢）。这里逐键 try 读取，读不到的键换成 `[Getter threw]` 标记，
 * 其余字段照常记录。
 * 顶层用 null 原型对象：`__proto__` 之类的键名只是普通字段，不会改动对象原型。
 *
 * @param {Record<string, any>} [fields] 附加字段（Error 序列化为 message+stack）
 * @returns {Record<string, any>} 可交给序列化器的字段
 */
function collectFields(fields) {
    /** @type {Record<string, any>} */
    const extra = Object.create(null);
    if (fields === null || fields === undefined) {
        return extra;
    }

    /** @type {string[]} */
    let keys;
    try {
        keys = Object.keys(fields);
    } catch {
        extra.fieldsUnserializable = '[Unreadable]'; // 字段集合本身不可枚举（Proxy 陷阱抛错等）
        return extra;
    }

    for (const key of keys) {
        try {
            /** @type {any} */
            const value = fields[key];
            extra[key] = value instanceof Error
                ? { message: value.message, stack: value.stack }
                : value;
        } catch {
            extra[key] = '[Getter threw]';
        }
    }
    return extra;
}

/**
 * 构造一行日志文本（不触碰写通道）
 *
 * @param {Date} now 记录时间（已经过 safeNow，可安全格式化）
 * @param {'info'|'warn'|'error'} level 本条日志等级
 * @param {string} message 日志消息
 * @param {Record<string, any>} [fields] 附加字段（Error 序列化为 message+stack）
 * @returns {string} 以换行结尾的完整日志行
 */
function formatLine(now, level, message, fields) {
    const extra = collectFields(fields);

    // 行格式：ISO时间(本地时区)\tLEVEL(定宽5)\t消息[\t附加字段JSON]
    const text = safeText(message).replaceAll(/[\r\n\t]/g, ' ');
    let line = `${localIso(now)}\t${levelText(level)}\t${text}`;
    if (Object.keys(extra).length > 0) {
        line += `\t${serializeFields(extra)}`;
    }
    return `${line}\n`;
}

/**
 * 兜底日志行：连 {@link formatLine} 都没能跑完时使用
 *
 * 只由已求值的时间、等级与尽力求取的消息拼成（不再触碰 fields），
 * 保证异常输入下仍留下一条可定位的记录。
 *
 * @param {Date} now 记录时间
 * @param {'info'|'warn'|'error'} level 本条日志等级
 * @param {any} message 原始日志消息
 * @param {any} err formatLine 抛出的异常
 * @returns {string} 以换行结尾的完整日志行
 */
function emergencyLine(now, level, message, err) {
    const text = safeText(message).replaceAll(/[\r\n\t]/g, ' ');
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : safeText(err);
    return `${localIso(now)}\t${levelText(level)}\t${text}\t${serializeFields({ logFailure: reason })}\n`;
}

/**
 * 输出一行结构化日志（stdout + 文件双通道）
 *
 * 等级未达阈值时直接返回（不产生任何 I/O）；日期取自 `Logger.now`（入口级唯一来源）。
 *
 * 本函数不向调用方抛错：Logger 正是 catch / onError 的兜底路径，它自己炸掉等于
 * 把"记一条日志"变成炸宿主。构造失败退化为兜底行；stdout 与文件两通道各自独立失败，
 * 任一不可用都不影响另一个。
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

    const now = safeNow();
    const date = localDate(now);

    let line;
    try {
        line = formatLine(now, level, message, fields);
    } catch (err) {
        try {
            line = emergencyLine(now, level, message, err);
        } catch {
            // 最后一道（不应发生）：连兜底行都构造不出来，也要留下时间与等级
            line = `${localIso(now)}\t${levelText(level)}\t(日志行构造失败)\n`;
        }
    }

    try {
        process.stdout.write(line);
    } catch {
        // stdout 不可写（管道断开、流已关闭）：仍尝试文件通道
    }
    fileWrite(line, date);
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
     *
     * 目录不必预先存在：赋值后由**下一次写入**负责创建（见 `writeToFile` 的滚动判定）。
     *
     * @returns {string} 日志目录绝对路径
     */
    static get logDir() {
        return logDirOverride ?? Config.resolveFromRoot('log');
    }

    /**
     * 重定向日志目录；传 null 恢复默认的宿主根下 log/
     *
     * 当日改目录同样会在新目录首写时建目录并按新目录清理，不需要额外重置状态；
     * `Config.setRootDir()` 改变默认目录时同理。
     *
     * @param {string|null} dir 日志目录
     */
    static set logDir(dir) {
        logDirOverride = dir === null ? null : String(dir);
    }

    /**
     * 默认等级（宿主根存在 dev.config.json 即 info，否则 warn）
     *
     * 结果按**开发配置路径**缓存：写日志是热路径，而 `Config.isDev()` 每次都要
     * `existsSync` 同步 stat（实测 9µs/次，占每条被丢弃日志 100% 的开销，且阻塞事件循环）。
     * 缓存随 `Config.devConfigFile` 路径变化自动失效；`Config.setRootDir()` 与显式
     * 改 `Config.devConfigFile` 会主动调用 `Logger.resetDevCache()`，因此切换宿主根、
     * 换开发配置路径后立即重新评估。
     *
     * 取舍：进程运行期在**同一路径**上增删 dev.config.json 不再即时生效，
     * 需重启进程、重新 `setRootDir()`，或显式调用 `Logger.resetDevCache()`
     * （生产环境该文件恒不存在，无影响）。
     *
     * @returns {'info'|'warn'} 默认等级
     */
    static get defaultLevel() {
        const file = Config.devConfigFile;
        if (devStatusCache.path !== file) {
            devStatusCache.path = file;
            devStatusCache.level = Config.isDev() ? 'info' : 'warn';
        }
        return devStatusCache.level;
    }

    /**
     * 失效默认等级缓存（宿主根或开发配置路径变更后调用）
     *
     * 下一次读取 `Logger.defaultLevel` 时重新检查 dev.config.json 是否存在。
     *
     * @returns {void}
     */
    static resetDevCache() {
        devStatusCache.path = null;
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
        cleanupDatedFiles(Logger.logDir);
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
