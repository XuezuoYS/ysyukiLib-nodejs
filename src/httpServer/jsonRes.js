import { AppError } from './appError.js';
import { getCurrentContext } from './context.js';

/**
 * 响应侧一行式输出门面（静态，写当前请求上下文）
 *
 * 全项目所有响应都经本门面写出，体输出等价 PHP
 * `json_encode($data, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE)`（契约）。
 *
 * 无响应体形态：`jsonRes(null)` / `fastResEmpty(code)` / `fastResRedirect(url, code)`
 * 只写状态码与附加头，**不设 Content-Type、不写响应体**（重定向、空 200/204）。
 * 注意与"省略 data 参数"（值为 undefined）区分：后者仍设 Content-Type 且写出空体。
 *
 * 响应修饰（header / cookie / status）必须在写出响应之前调用。
 *
 * 常用函数：
 * - jsonRes(data, httpCode, headers)：统一 JSON 出口
 * - fastResEmpty(httpCode)：无响应体（默认 200）
 * - fastResRedirect(url, httpCode)：3xx 重定向（默认 307，仅 Location 头；不终止控制流，需自行 return）
 * - fastResError(message, httpCode)：抛 AppError，交由入口唯一兜底出口输出
 * - header(name, value) / cookie(name, value, options) / status(httpCode)
 *
 */
export class JsonRes {
    /**
     * 返回 JSON 数据（统一出口）
     *
     * @param {any} data 响应数据；显式传 null 表示无响应体且不声明 Content-Type
     * @param {number} [httpCode] HTTP 状态码；省略时沿用当前状态码（新建响应为 200），
     * 因此 `status(201)` 之后调用 `jsonRes(data)` 不会把状态码打回 200
     * @param {Record<string, string>|null} [headers] 附加响应头；先于 Content-Type 设置，
     * 同名时由本方法覆盖
     * @default headers = null
     */
    static jsonRes(data, httpCode, headers = null) {
        JsonRes.#write(getCurrentContext().res, data, httpCode, headers);
    }

    /**
     * 返回无响应体（空 200/204 等）
     *
     * @param {number} [httpCode] HTTP 状态码；省略时沿用当前状态码
     */
    static fastResEmpty(httpCode) {
        JsonRes.#write(getCurrentContext().res, null, httpCode, null);
    }

    /**
     * 快速返回重定向响应
     *
     * 307 语义：客户端必须以相同方法与请求体重放到目标地址；
     * 若希望浏览器改用 GET 重放，显式传 303（302 在各实现中对 POST 处理不一致，不推荐）。
     *
     * 与 fastResError 不同：本方法不抛异常、**不终止控制流**，调用后必须自行 `return`。
     *
     * @param {string} url 重定向目标；站内跳转用相对路径，完整 URL 不得回填内部监听地址
     * @param {number} [httpCode] HTTP 3xx 状态码
     * @default httpCode = 307
     */
    static fastResRedirect(url, httpCode = 307) {
        // url 含 CR/LF 等非法头字符时由 setHeader 抛出 ERR_INVALID_CHAR，
        // 落入口唯一兜底出口转 500，不会写出被污染的响应头（响应头注入防护）
        JsonRes.#write(getCurrentContext().res, null, httpCode, { Location: url });
    }

    /**
     * 快速返回错误信息
     *
     * throw AppError，由入口唯一兜底出口输出 `{ "status": message }`。
     *
     * @param {string} [message] 错误信息
     * @default message = '参数错误'
     * @param {number} [httpCode] HTTP 状态码
     * @default httpCode = 400
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
     * @param {string} name Cookie 名
     * @param {string} value Cookie 值（自动 URL 编码）
     * @param {object} [options] 属性
     * @param {string} [options.path] 路径，默认 '/'
     * @param {number} [options.maxAge] 有效期（秒）
     * @param {string|Date} [options.expires] 过期时间
     * @param {string} [options.domain] 作用域
     * @param {boolean} [options.secure] 仅 HTTPS
     * @param {boolean} [options.httpOnly] 禁止脚本读取，默认 true
     * @param {'Strict'|'Lax'|'None'} [options.sameSite] SameSite 策略，默认 'Lax'
     * @default options = {}
     */
    static cookie(name, value, options = {}) {
        const parts = [`${name}=${encodeURIComponent(String(value))}`];
        if (options.maxAge !== undefined) {
            parts.push(`Max-Age=${Math.floor(Number(options.maxAge))}`);
        }
        if (options.expires !== undefined) {
            parts.push(`Expires=${new Date(options.expires).toUTCString()}`);
        }
        if (options.domain !== undefined) {
            parts.push(`Domain=${options.domain}`);
        }
        parts.push(`Path=${options.path ?? '/'}`);
        if (options.secure === true) {
            parts.push('Secure');
        }
        if (options.httpOnly !== false) {
            parts.push('HttpOnly');
        }
        parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);

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
     * @param {import('node:http').ServerResponse} res 响应对象
     * @param {any} data 响应数据；显式 null 为无体形态
     * @param {number|undefined} httpCode HTTP 状态码；undefined 表示沿用当前状态码
     * @param {Record<string, string>|null} extraHeaders 附加响应头（先于 Content-Type 设置）
     */
    static #write(res, data, httpCode, extraHeaders) {
        res.statusCode = httpCode ?? res.statusCode ?? 200;
        if (extraHeaders !== null) {
            for (const [name, value] of Object.entries(extraHeaders)) {
                res.setHeader(name, value);
            }
        }

        if (data === null) {
            // 无体形态：不声明 Content-Type: application/json，也不写出任何字节
            res.end();
            return;
        }

        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        // HEAD 语义：响应头照常写出，响应体抑制（内容长度由客户端按 GET 语义推断）
        if (getCurrentContext().method === 'HEAD') {
            res.end();
            return;
        }
        // 4 空格缩进即 JSON_PRETTY_PRINT；斜杠与非 ASCII 不转义是 stringify 默认（两 UNESCAPED 标志）
        res.end(JSON.stringify(data, null, 4));
    }
}
