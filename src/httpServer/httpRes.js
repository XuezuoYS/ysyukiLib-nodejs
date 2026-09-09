import { AppError } from './appError.js';
import { getCurrentContext } from './context.js';

/**
 * @fileoverview 响应侧一行式输出门面（静态，写当前请求上下文）
 *
 * 全项目所有响应都经本门面写出，体输出等价 PHP
 * `json_encode($data, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE)`（契约）。
 *
 * 无响应体形态：`jsonRes(null)` / `fastResEmpty(code)` / `fastResRedirect(url, code)`
 * 只写状态码与附加头，**不设 Content-Type、不写响应体**（重定向、空 200/204）。
 * 注意与"省略 data 参数"（值为 undefined）区分：后者仍设 Content-Type 且写出空体
 * （GET 为空体，HEAD 声明 `Content-Length: 0`，与 GET 的头保持一致）。
 *
 * 响应修饰（header / cookie / status）必须在写出响应之前调用。
 *
 * 每次写出后按状态码记一行响应状态日志（1/2/3 → INFO、4/5 → WARN，其它前缀不记），
 * 由 `ServerLogger.response` 决定等级与文本格式；是否真正记录随所属 HttpServer
 * 实例的日志等级阈值（生产默认 warn：只留 4/5）。
 *
 * 常用函数：
 * - jsonRes(data, httpCode, headers)：统一 JSON 出口
 * - fastResEmpty(httpCode)：无响应体（默认 200）
 * - fastResRedirect(url, httpCode)：3xx 重定向（默认 307，仅 Location 头；不终止控制流，需自行 return）
 * - fastResError(message, httpCode)：抛 AppError，交由入口唯一兜底出口输出
 * - header(name, value) / cookie(name, value, options) / status(httpCode)
 *
 */

/**
 * Cookie 名合法字符集（RFC 6265 token：不含空格、控制字符与分隔符）
 * @type {RegExp}
 */
const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Cookie Domain 合法主机名（每个标签 1-63 字符、字母数字与连字符、不以连字符开头/结尾）
 * @type {RegExp}
 */
const COOKIE_DOMAIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/** Cookie Domain 总长度上限（RFC 1035 主机名上限） */
const MAX_DOMAIN_LENGTH = 253;

/** Cookie Path 合法字符（RFC 6265 av-octet：可打印 ASCII 去掉 `;`） */
const COOKIE_PATH_PATTERN = /^[\x20-\x3A\x3C-\x7E]*$/;

/** SameSite 白名单（大小写不敏感，输出规范化）
 * @type {Map<string, 'Strict'|'Lax'|'None'>}
 */
const SAMESITE_VALUES = new Map([['strict', 'Strict'], ['lax', 'Lax'], ['none', 'None']]);

/**
 * 属性值是否"未设置"（undefined / null / '' / false）
 *
 * `false` 一并算未设置，兼容 `Config.getConfig(key)` 取不到时返回 false 的常见写法。
 *
 * @param {any} value 属性值
 * @returns {boolean} 是否未设置
 */
function isUnset(value) {
    return value === undefined || value === null || value === false || value === '';
}

/**
 * 校验并规范化 Domain 属性
 *
 * 允许前导点（`Domain=.example.com`，浏览器会忽略该点）；IDN 需先转 punycode。
 *
 * @param {any} domain domain 值
 * @returns {string|null} 规范化后的域名，未设置返回 null
 * @throws {Error} 域名语法非法
 */
function normalizeDomain(domain) {
    if (isUnset(domain)) {
        return null;
    }
    const text = String(domain);
    const host = text.startsWith('.') ? text.slice(1) : text;
    if (host.length === 0 || host.length > MAX_DOMAIN_LENGTH || !COOKIE_DOMAIN_PATTERN.test(host)) {
        throw new Error(`Cookie Domain 非法：${text}（须为合法主机名，IDN 请先转 punycode）`);
    }
    return text;
}

/**
 * 校验并规范化 Path 属性
 *
 * @param {any} path path 值
 * @returns {string} 规范化后的路径（未设置时为 '/'）
 * @throws {Error} 不以 `/` 开头，或含 `;`、控制字符、非 ASCII 字符
 */
function normalizePath(path) {
    if (isUnset(path)) {
        return '/';
    }
    const text = String(path);
    if (!text.startsWith('/') || !COOKIE_PATH_PATTERN.test(text)) {
        throw new Error(`Cookie Path 非法：${text}（须以 / 开头，且只含可打印 ASCII、不含 ; ）`);
    }
    return text;
}

/**
 * 校验并规范化 Max-Age 属性
 *
 * @param {any} maxAge 有效期（秒）
 * @returns {number|null} 整数秒（<= 0 表示删除 Cookie），未设置返回 null
 * @throws {Error} 非有限数字
 */
function normalizeMaxAge(maxAge) {
    if (isUnset(maxAge)) {
        return null;
    }
    const seconds = Number(maxAge);
    if (!Number.isFinite(seconds)) {
        throw new Error(`Cookie Max-Age 非法：${String(maxAge)}（须为有限数字，单位秒）`);
    }
    return Math.floor(seconds);
}

/**
 * 校验并规范化 Expires 属性
 *
 * @param {any} expires 过期时间（Date / ISO 字符串 / 时间戳）
 * @returns {string|null} UTC 时间字符串，未设置返回 null
 * @throws {Error} 无法解析为合法日期
 */
function normalizeExpires(expires) {
    if (isUnset(expires)) {
        return null;
    }
    const date = new Date(expires);
    if (Number.isNaN(date.getTime())) {
        throw new Error(`Cookie Expires 非法：${String(expires)}（须为 Date / ISO 字符串 / 时间戳）`);
    }
    return date.toUTCString();
}

/**
 * 校验并规范化 SameSite 属性
 *
 * @param {any} sameSite sameSite 值
 * @returns {'Strict'|'Lax'|'None'} 规范化后的取值（未设置时为 'Lax'）
 * @throws {Error} 取值不在白名单
 */
function normalizeSameSite(sameSite) {
    if (isUnset(sameSite)) {
        return 'Lax';
    }
    const normalized = SAMESITE_VALUES.get(String(sameSite).toLowerCase());
    if (normalized === undefined) {
        throw new Error(`Cookie SameSite 非法：${String(sameSite)}（可用 Strict / Lax / None）`);
    }
    return normalized;
}

/**
 * 响应输出门面（全静态方法，写当前请求上下文）
 *
 * 契约摘要：全项目响应都经本门面写出，体输出等价 PHP
 * `json_encode($data, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE)`；
 * 响应修饰（header / cookie / status）必须在写出响应之前调用；
 * 无响应体形态（`jsonRes(null)` / `fastResEmpty` / `fastResRedirect`）不设 Content-Type、不写响应体。
 *
 * 完整约定（状态日志分级、HEAD 一致性、省略 data 与显式 null 的区别）见本文件顶部 `@fileoverview`。
 *
 * 常用入口：jsonRes / fastResEmpty / fastResRedirect / fastResError / header / cookie / status
 */
export class HttpRes {
    /**
     * 返回 JSON 数据（统一出口）
     *
     * @default headers = null
     * @param {any} data 响应数据；显式传 null 表示无响应体且不声明 Content-Type
     * @param {number} [httpCode] HTTP 状态码；省略时沿用当前状态码（新建响应为 200），
     * 因此 `status(201)` 之后调用 `jsonRes(data)` 不会把状态码打回 200
     * @param {Record<string, string>|null} [headers] 附加响应头；先于 Content-Type 设置，
     * 同名时由本方法覆盖
     */
    static jsonRes(data, httpCode, headers = null) {
        HttpRes.#write(getCurrentContext().res, data, httpCode, headers);
    }

    /**
     * 返回无响应体（空 200/204 等）
     *
     * @param {number} [httpCode] HTTP 状态码；省略时沿用当前状态码
     */
    static fastResEmpty(httpCode) {
        HttpRes.#write(getCurrentContext().res, null, httpCode, null);
    }

    /**
     * 快速返回重定向响应
     *
     * 307 语义：客户端必须以相同方法与请求体重放到目标地址；
     * 若希望浏览器改用 GET 重放，显式传 303（302 在各实现中对 POST 处理不一致，不推荐）。
     *
     * 与 fastResError 不同：本方法不抛异常、**不终止控制流**，调用后必须自行 `return`。
     *
     * @default httpCode = 307
     * @param {string} url 重定向目标；站内跳转用相对路径，完整 URL 不得回填内部监听地址
     * @param {number} [httpCode] HTTP 3xx 状态码
     */
    static fastResRedirect(url, httpCode = 307) {
        // url 含 CR/LF 等非法头字符时由 setHeader 抛出 ERR_INVALID_CHAR，
        // 落入口唯一兜底出口转 500，不会写出被污染的响应头（响应头注入防护）
        HttpRes.#write(getCurrentContext().res, null, httpCode, { Location: url });
    }

    /**
     * 快速返回错误信息
     *
     * throw AppError，由入口唯一兜底出口输出 `{ "status": message }`。
     *
     * @default message = '参数错误', httpCode = 400
     * @param {string} [message] 错误信息
     * @param {number} [httpCode] HTTP 状态码
     */
    static fastResError(message = '参数错误', httpCode = 400) {
        throw new AppError(message, httpCode);
    }

    /**
     * 设置响应状态码（须在写出响应之前调用）
     *
     * @param {number} httpCode HTTP 状态码
     */
    static status(httpCode) {
        getCurrentContext().res.statusCode = httpCode;
    }

    /**
     * 设置响应头（须在写出响应之前调用）
     *
     * @param {string} name 头名
     * @param {string|string[]} value 头值
     */
    static header(name, value) {
        getCurrentContext().res.setHeader(name, value);
    }

    /**
     * 追加 Set-Cookie（同名 Cookie 可多次调用，互不覆盖）
     *
     * 所有属性先校验再写出：非法值抛普通 Error（服务端配置错误 → 入口兜底出口记 error 日志并输出 500），
     * 不会把畸形属性写进 Set-Cookie；空值（`undefined` / `null` / `''` / `false`）一律视为未设置。
     *
     * @default options = {}
     * @param {string} name Cookie 名（须为 RFC 6265 token）
     * @param {string} value Cookie 值（自动 URL 编码）
     * @param {object} [options] 属性
     * @param {string|null|false} [options.path] 路径，默认 '/'（须以 `/` 开头、只含可打印 ASCII、不含 `;`）
     * @param {number|null|false} [options.maxAge] 有效期（秒，须为有限数字；<= 0 表示删除）
     * @param {string|Date|null|false} [options.expires] 过期时间（Date / ISO 字符串 / 时间戳）
     * @param {string|null|false} [options.domain] 作用域（合法主机名，可带前导点；IDN 请先转 punycode）
     * @param {boolean} [options.secure] 仅 HTTPS
     * @param {boolean} [options.httpOnly] 禁止脚本读取，默认 true
     * @param {string|null|false} [options.sameSite] SameSite 策略，默认 'Lax'（大小写不敏感的
     * Strict / Lax / None；`None` 需同时 `secure: true`，这是浏览器要求，库不强制）
     * @throws {Error} Cookie 名或任一属性值非法（服务端编程/配置错误，非 AppError）
     */
    static cookie(name, value, options = {}) {
        const cookieName = String(name);
        if (!COOKIE_NAME_PATTERN.test(cookieName)) {
            // 名字由服务端代码决定，非法名属服务端编程错误：抛普通 Error，
            // 由入口兜底出口记 error 日志（含堆栈）并输出 500，而不是把责任推给客户端的 400
            throw new Error(`Cookie 名非法：${cookieName}（须为 RFC 6265 token）`);
        }

        const maxAge = normalizeMaxAge(options.maxAge);
        const expires = normalizeExpires(options.expires);
        const domain = normalizeDomain(options.domain);
        const path = normalizePath(options.path);
        const sameSite = normalizeSameSite(options.sameSite);

        const parts = [`${cookieName}=${encodeURIComponent(String(value))}`];
        if (maxAge !== null) {
            parts.push(`Max-Age=${maxAge}`);
        }
        if (expires !== null) {
            parts.push(`Expires=${expires}`);
        }
        if (domain !== null) {
            parts.push(`Domain=${domain}`);
        }
        parts.push(`Path=${path}`);
        if (options.secure === true) {
            parts.push('Secure');
        }
        if (options.httpOnly !== false) {
            parts.push('HttpOnly');
        }
        parts.push(`SameSite=${sameSite}`);

        const { res } = getCurrentContext();
        const line = parts.join('; ');
        if (typeof res.appendHeader === 'function') {
            res.appendHeader('Set-Cookie', line);
            return;
        }
        const previous = res.getHeader('Set-Cookie');
        res.setHeader(
            'Set-Cookie',
            previous === undefined
                ? line
                : (Array.isArray(previous) ? [...previous, line] : [String(previous), line]),
        );
    }

    /**
     * 统一写出（内部）
     *
     * 写出完成后按状态码记一行响应状态日志（1/2/3 → INFO、4/5 → WARN，其它前缀不记）：
     * 本方法是全项目响应的唯一出口，凡经此处写出的响应（含 404/405/AppError/500 兜底）
     * 都会记录；写出本身失败时不记——那时实际返回客户端的是入口兜底出口写出的状态码。
     *
     * @param {import('node:http').ServerResponse} res 响应对象
     * @param {any} data 响应数据；显式 null 为无体形态
     * @param {number|undefined} httpCode HTTP 状态码；undefined 表示沿用当前状态码
     * @param {Record<string, string>|null} extraHeaders 附加响应头（先于 Content-Type 设置）
     */
    static #write(res, data, httpCode, extraHeaders) {
        const ctx = getCurrentContext();
        // 标记"本次请求已写出响应"：入口据此识别主动短路的中间件（如 CORS 预检），
        // 不能依赖 res.headersSent / writableEnded——res.end() 后同一次同步执行内二者可能仍为 false。
        ctx.responded = true;
        res.statusCode = httpCode ?? res.statusCode ?? 200;
        if (extraHeaders !== null) {
            for (const [name, value] of Object.entries(extraHeaders)) {
                res.setHeader(name, value);
            }
        }

        if (data === null) {
            // 无体形态：不声明 Content-Type: application/json，也不写出任何字节
            res.end();
        } else {
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            // 4 空格缩进即 JSON_PRETTY_PRINT；斜杠与非 ASCII 不转义是 stringify 默认（两 UNESCAPED 标志）
            // data 为 undefined（省略入参的空体契约形态）/ 函数 / symbol 时 stringify 返回 undefined
            // 而不是字符串：GET 走 `res.end(undefined)`，即"设 Content-Type、写出空体"，保持不变。
            const text = /** @type {string|undefined} */ (JSON.stringify(data, null, 4));
            // HEAD 语义：头部应与 GET 一致（RFC 9110），只是没有 body。
            // 必须显式写 Content-Length——node 对 HEAD 请求会吞掉 res.end(text) 的长度并丢弃 body，
            // 不显式声明则客户端拿不到实体长度（无法预知大小、无法做下载进度）。
            if (ctx.method === 'HEAD') {
                // 空体形态（text 为 undefined）的实体长度为 0，与 GET 的 Content-Length: 0 对齐；
                // 此处不得把 undefined 直接交给 byteLength——会抛 ERR_INVALID_ARG_TYPE 并转成 500。
                res.setHeader('Content-Length', String(Buffer.byteLength(text ?? '', 'utf8')));
                res.end();
            } else {
                res.end(text);
            }
        }

        // 状态码日志是旁路通道：自定义 ctx 的 logger 未实现 response 时静默跳过，
        // 不得让日志把已经写出的响应变成异常（那会被兜底出口判定为"响应已开始后异常"并 destroy）
        ctx.logger.response?.(res.statusCode);
    }
}
