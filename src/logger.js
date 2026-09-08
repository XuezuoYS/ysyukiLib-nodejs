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
 * 级别门控：开发环境（宿主根 dev.config.json 在场，见 Config.isDev()）记录全部级别；
 * 非开发环境仅记录 warn 与 error（stdout 与文件同门控）。
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
 * - Logger.info(message, fields):一般信息（仅开发环境）
 * - Logger.warn(message, fields):警告
 * - Logger.error(message, fields):错误（fields 中的 Error 对象会序列化为 message+stack）
 *
 */
export class Logger {
    /** 日期文件前缀与保留天数 */
    static #prefix = 'app-';
    static #keepDays = 3;

    /**
     * 显式指定的日志目录（null 表示宿主项目根下 log/）
     * @type {string|null}
     */
    static #logDir = null;

    /**
     * 时间源（测试可注入固定时钟以驱动跨日滚动）
     *
     * @returns {Date} 当前时间
     */
    static now = () => new Date();

    /** 上一次文件写入的本地日期（跨天滚动判定用）
     * @type {string}
     */
    static #lastDate = '';

    /**
     * 日志目录（默认宿主项目根下 log/，随宿主根解析，可显式赋值重定向）
     * @returns {string} 日志目录绝对路径
     */
    static get logDir() {
        return Logger.#logDir ?? Config.resolveFromRoot('log');
    }

    /**
     * @param {string|null} dir 日志目录
     */
    static set logDir(dir) {
        Logger.#logDir = dir === null ? null : String(dir);
    }

    /**
     * 当前本地日期 YYYY-MM-DD（文件按服务器本地日切分，与业务 date 语义一致）
     *
     * @param {Date} now 当前时间
     * @returns {string} 日期字符串
     */
    static #localDate(now) {
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
    static #localIso(now) {
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
     * 清理超出保留数量的旧日期文件（滚动时自动调用，亦可手动调用）
     *
     * 仅匹配 app-YYYY-MM-DD.log 命名，目录内其他文件不受影响。
     */
    static cleanup() {
        /** @type {string[]} */
        const dated = readdirSync(Logger.logDir)
            .filter((name) => new RegExp(`^${Logger.#prefix}\\d{4}-\\d{2}-\\d{2}\\.log$`).test(name))
            .sort();
        while (dated.length > Logger.#keepDays) {
            rmSync(join(Logger.logDir, dated.shift()), { force: true });
        }
    }

    /**
     * 追加一行到当日日志文件；任何文件层错误静默忽略（stdout 通道已输出）
     *
     * 跨日首写：先建目录（缺失时），追加后再清理——使当日新文件计入保留数。
     *
     * @param {string} line 含行尾换行的完整日志行
     * @param {string} date 本地日期
     */
    static #fileWrite(line, date) {
        try {
            const isNewDay = Logger.#lastDate !== date;
            if (isNewDay && !existsSync(Logger.logDir)) {
                mkdirSync(Logger.logDir, { recursive: true });
            }
            appendFileSync(join(Logger.logDir, Logger.#prefix + date + '.log'), line, 'utf8');
            if (isNewDay) {
                Logger.cleanup();
                Logger.#lastDate = date;
            }
        } catch {
            // 落盘失败不影响请求路径
        }
    }

    /**
     * 输出一行结构化日志
     *
     * @param {string} levelName 日志级别（info/warn/error）
     * @param {string} message 日志消息
     * @param {Record<string, any>} [fields] 附加字段（如请求路径、错误对象等）
     * @default fields = {}
     */
    static #write(levelName, message, fields = {}) {
        // 非开发环境仅保留 warn/error（stdout 与文件同门控）
        if (!Config.isDev() && levelName !== 'warn' && levelName !== 'error') {
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
        const level = levelName.toUpperCase().padEnd(5);
        let line = `${Logger.#localIso(now)}\t${level}\t${message}`;
        if (Object.keys(extra).length > 0) {
            line += `\t${JSON.stringify(extra)}`;
        }
        line += '\n';

        process.stdout.write(line);
        Logger.#fileWrite(line, Logger.#localDate(now));
    }

    /**
     * 记录 info 级别日志
     *
     * @param {string} message 日志消息
     * @param {Record<string, any>} [fields] 附加字段
     */
    static info(message, fields) {
        Logger.#write('info', message, fields);
    }

    /**
     * 记录 warn 级别日志
     *
     * @param {string} message 日志消息
     * @param {Record<string, any>} [fields] 附加字段
     */
    static warn(message, fields) {
        Logger.#write('warn', message, fields);
    }

    /**
     * 记录 error 级别日志
     *
     * @param {string} message 日志消息
     * @param {Record<string, any>} [fields] 附加字段（Error 对象放入 err 字段）
     */
    static error(message, fields) {
        Logger.#write('error', message, fields);
    }
}
