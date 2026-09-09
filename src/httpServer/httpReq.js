import { AppError } from './appError.js';
import { getCurrentContext } from './context.js';

/**
 * @fileoverview 请求侧一行式取值门面（静态，读当前请求上下文）
 *
 * 一行式：`HttpReq.getPostData('key', 'int', 0)`；
 * 字段不存在（或值为 null）时：显式传入默认值则返回默认值，否则抛
 * AppError(400, '参数错误')，由入口唯一兜底出口输出 `{ "status": message }`。
 * 字段存在但类型不符时始终抛错（默认值不生效）。
 *
 * 类型语义：
 * - string：字符串
 * - int：整数（拒绝小数、数字字符串、布尔）
 * - bool：布尔值
 * - array：数组（JSON 对象一并接受，结构语义）
 * - float：数字（允许数字字符串并强转）
 * - none：不校验
 *
 * 字符串来源（query / param）的值天然是字符串，故 int / float / bool
 * 允许从字符串强转（int 仅接受整数形式，bool 接受 true/false/1/0）；
 * 路径参数还会被 Router 预先按模板类型转换（int / float → number，bool → boolean），
 * getParam 在已转换值之上再校验一次，两种来源写法一致。
 *
 * `application/x-www-form-urlencoded` 请求体同样是字符串来源（见 `parseFormBody`），
 * 因此 `getPostData` 按 bodySource 选择语义：JSON 体走严格校验（数字必须是数字），
 * 表单体走字符串强转（`'42'` 可取 int、`'true'` 可取 bool）。
 * 两种请求体的调用写法完全一致：`HttpReq.getPostData('page', 'int', 1)`。
 *
 * 取值类型保证：声明了 type 的取值一律返回该类型（string → string、int / float → number、
 * bool → boolean、array → array）。字符串来源（请求体表单 / query / param / header / cookie）
 * 按字符串来源语义强转；值缺失时返回显式缺省值，未显式传缺省值则返回该类型的零值
 * （bool → false、int / float → 0、array → []、string / none → ''）。
 * getHeader / getCookie 的第二参为 type（默认 none），不是已知类型名时按缺省值处理，
 * 兼容旧写法 `getHeader('x-missing', 'def')` / `getCookie('sid', 'def')`；
 * 注意 `'none'` 等已知类型名作为第二参会被当作类型声明，不再能当缺省值字面量使用
 * （旧写法 `getCookie('sid', 'none')` 已改为返回该类型的零值，缺省值请用第三参）。
 *
 * 常用函数：
 * - getPostData(name, type, default?)：请求体取值
 * - getQuery(name, type, default?)：查询串取值
 * - getParam(name, type, default?)：路径参数取值
 * - getHeader(name, type, default?) / getCookie(name, type, default?) / getIp()
 * - getRawBody() / getBody() / getMethod() / getPath() / getRequestId() / current()
 */

/**
 * 请求侧取值门面（全静态方法，读当前请求上下文）
 *
 * 契约摘要：一行式 `HttpReq.getPostData('key', 'int', 0)`；字段不存在（或值为 null）时——
 * 显式传入默认值则返回默认值，否则抛 AppError(400, '参数错误')；
 * 字段存在但类型不符时始终抛错（默认值不生效）；声明了 type 的取值一律返回该类型。
 *
 * 完整约定（类型语义、字符串来源强转、表单体与 JSON 体的差异）见本文件顶部 `@fileoverview` 与 docs/httpServer.md。
 *
 * 常用入口：getPostData / getQuery / getParam / getHeader / getCookie / getIp / getRawBody / getBody / getMethod / getPath / getRequestId
 */
export class HttpReq {
    /**
     * 获取请求体数据项
     *
     * 校验语义随请求体来源（ctx.bodySource）：
     * JSON 体为严格校验；`application/x-www-form-urlencoded` 体为字符串强转，
     * 调用方无需区分来源，写法一致。
     *
     * @default type = 'none'
     * @param {string} name 字段名
     * @param {string} [type] 类型，none 则不校验
     * @param {...any} rest 默认值（仅当显式传入时生效，用参数个数判断，支持默认值本身为 null）
     * @returns {any} 字段值或默认值
     */
    static getPostData(name, type = 'none', ...rest) {
        const ctx = getCurrentContext();
        const body = ctx.body;
        const exists = body !== null && typeof body === 'object'
            && Object.prototype.hasOwnProperty.call(body, name)
            && body[name] !== null;
        const source = ctx.bodySource === 'form' ? 'string' : 'strict';
        return readField(exists, exists ? body[name] : undefined, type, rest, source);
    }

    /**
     * 获取查询串数据项
     *
     * @default type = 'none'
     * @param {string} name 参数名
     * @param {string} [type] 类型，none 则不校验
     * @param {...any} rest 默认值（仅当显式传入时生效）
     * @returns {any} 参数值或默认值
     */
    static getQuery(name, type = 'none', ...rest) {
        const ctx = getCurrentContext();
        const exists = ctx.query.has(name);
        return readField(exists, exists ? ctx.query.get(name) : undefined, type, rest, 'string');
    }

    /**
     * 获取路径参数数据项
     *
     * @default type = 'none'
     * @param {string} name 参数名
     * @param {string} [type] 类型，none 则不校验
     * @param {...any} rest 默认值（仅当显式传入时生效）
     * @returns {any} 参数值或默认值
     */
    static getParam(name, type = 'none', ...rest) {
        const ctx = getCurrentContext();
        const params = ctx.params;
        const exists = Object.prototype.hasOwnProperty.call(params, name);
        return readField(exists, exists ? params[name] : undefined, type, rest, 'param');
    }

    /**
     * 获取请求头（键名大小写不敏感）
     *
     * 请求头值天然是字符串，故按字符串来源语义转换（与 query 一致）：
     * `getHeader('x-num', 'int')` 得到 number。第二参不是已知类型名时按"缺省值"处理
     * （兼容旧写法 `getHeader('x-missing', 'def')`）。
     * 头缺失时返回缺省值；未显式传缺省值时按 type 返回零值（bool → false、
     * int / float → 0、array → []、string / none / 其它 → ''）。
     *
     * @default type = 'none', defaultValue = undefined
     * @param {string} name 头名
     * @param {string} [type] 类型，none 则不校验（非已知类型名时视为缺省值）
     * @param {any} [defaultValue] 缺省值；省略时按 type 取零值
     * @returns {any} 头值（同名多值以 `, ` 连接）按 type 转换后的值，或缺省值
     */
    static getHeader(name, type = 'none', defaultValue = undefined) {
        const { req } = getCurrentContext();
        const raw = req.headers[String(name).toLowerCase()];
        const exists = raw !== undefined;
        const value = exists && Array.isArray(raw) ? raw.join(', ') : raw;
        return readScalar(exists, value, type, defaultValue);
    }

    /**
     * 获取 Cookie（按需解析 `Cookie` 头，结果缓存在本次请求上下文）
     *
     * Cookie 值天然是字符串，故按字符串来源语义转换（与 query 一致）：
     * `getCookie('ci', 'int')` 得到 number、`getCookie('cb', 'bool')` 得到 boolean。
     * 第二参不是已知类型名时按"缺省值"处理（兼容旧写法 `getCookie('sid', 'def')`）。
     * Cookie 缺失时返回缺省值；未显式传缺省值时按 type 返回零值（bool → false、
     * int / float → 0、array → []、string / none / 其它 → ''）。
     *
     * @default type = 'none', defaultValue = undefined
     * @param {string} name Cookie 名
     * @param {string} [type] 类型，none 则不校验（非已知类型名时视为缺省值）
     * @param {any} [defaultValue] 缺省值；省略时按 type 取零值
     * @returns {any} Cookie 值按 type 转换后的值，或缺省值
     */
    static getCookie(name, type = 'none', defaultValue = undefined) {
        const ctx = getCurrentContext();
        if (ctx.cookies === undefined) {
            ctx.cookies = parseCookieHeader(HttpReq.getHeader('cookie'));
        }
        const exists = Object.prototype.hasOwnProperty.call(ctx.cookies, name);
        return readScalar(exists, exists ? ctx.cookies[name] : undefined, type, defaultValue);
    }

    /**
     * 获取客户端 IP
     *
     * 优先取 `x-forwarded-for` 首项（反代场景），否则取 socket 远端地址。
     *
     * @returns {string} 客户端 IP（取不到时为空串）
     */
    static getIp() {
        const { req } = getCurrentContext();
        const forwarded = req.headers['x-forwarded-for'];
        const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
        if (typeof raw === 'string' && raw !== '') {
            return raw.split(',')[0].trim();
        }
        return req.socket?.remoteAddress ?? '';
    }

    /**
     * 获取请求体原始文本
     * @returns {string} 请求体文本（无体时为空串）
     */
    static getRawBody() {
        return getCurrentContext().rawBody;
    }

    /**
     * 获取整个请求体对象
     * @returns {Record<string, any>} 已解析的请求体
     */
    static getBody() {
        return getCurrentContext().body;
    }

    /**
     * 获取 HTTP 方法（大写）
     * @returns {string} 方法名
     */
    static getMethod() {
        return getCurrentContext().method;
    }

    /**
     * 获取归一化后的请求路径
     * @returns {string} 路径
     */
    static getPath() {
        return getCurrentContext().path;
    }

    /**
     * 获取请求标识
     * @returns {string} requestId
     */
    static getRequestId() {
        return getCurrentContext().requestId;
    }

    /**
     * 获取当前请求上下文（进阶用法：直接操作 req/res/state）
     * @returns {import('./context.js').HttpContext} 请求上下文
     */
    static current() {
        return getCurrentContext();
    }
}

/**
 * 已知类型名（用于区分"类型位"与旧写法的"缺省值位"）
 * @type {Record<string, true>}
 */
const TYPE_NAMES = {
    none: true, string: true, int: true, bool: true, array: true, float: true,
};

/**
 * 类型对应的零值（值缺失且未显式传缺省值时返回）
 *
 * @param {string} type 类型名
 * @returns {any} 零值：bool → false、int / float → 0、array → []、其余（含 none）→ ''
 */
function zeroValueForType(type) {
    switch (type) {
        case 'bool':
            return false;
        case 'int':
        case 'float':
            return 0;
        case 'array':
            return [];
        default:
            return '';
    }
}

/**
 * 单值来源（header / cookie）取值：按字符串来源校验，值缺失时返回缺省值
 *
 * 第二参不是已知类型名时视为"缺省值"（兼容 `getHeader('x', 'def')` 旧写法）；
 * 未显式传缺省值时按 type 返回零值，使调用方拿到的类型始终与声明一致。
 *
 * @param {boolean} exists 值是否存在
 * @param {any} value 原始值（字符串来源）
 * @param {string} typeArg 类型名或缺省值
 * @param {any} defaultValue 显式缺省值（undefined 表示未传）
 * @returns {any} 转换后的值或缺省值
 */
function readScalar(exists, value, typeArg, defaultValue) {
    const isType = Object.prototype.hasOwnProperty.call(TYPE_NAMES, typeArg);
    const type = isType ? typeArg : 'none';
    const fallback = isType ? defaultValue : (defaultValue === undefined ? typeArg : defaultValue);

    if (!exists) {
        return fallback === undefined ? zeroValueForType(type) : fallback;
    }
    return validateFromString(String(value), type);
}

/**
 * 构造类型错误（文案属对外契约，勿改动）
 *
 * @param {string} type 期望类型
 * @returns {AppError} 400 类型错误
 */
function typeError(type) {
    return new AppError(`类型错误，需要的类型：${type}`, 400);
}

/**
 * 数字字符串判定（十进制子集；十六进制字符串不算数字）
 *
 * @param {string} value 待判定字符串
 * @returns {boolean} 是否为数字字符串
 */
function isNumericString(value) {
    return /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(value);
}

/**
 * 布尔字符串解析
 *
 * @param {string} value 待解析字符串
 * @returns {boolean|null} true/false，无法判定时 null
 */
function parseBooleanString(value) {
    if (value === 'true' || value === '1') {
        return true;
    }
    if (value === 'false' || value === '0') {
        return false;
    }
    return null;
}

/**
 * 读取字段并按来源语义校验
 *
 * @param {boolean} exists 字段是否存在且非 null
 * @param {any} value 字段值
 * @param {string} type 类型名
 * @param {any[]} rest 默认值参数（长度 >= 1 表示显式传入）
 * @param {'strict'|'string'|'param'} source 校验语义：strict 为请求体，
 * string 为字符串来源（query），param 为路径参数（可能已被路由按类型转换）
 * @returns {any} 校验/强转后的值
 */
function readField(exists, value, type, rest, source) {
    if (!exists) {
        if (rest.length >= 1) {
            return rest[0];
        }
        throw new AppError('参数错误', 400);
    }
    if (source === 'strict') {
        return validateStrict(value, type);
    }
    if (source === 'param') {
        return validateParam(value, type);
    }
    return validateFromString(value, type);
}

/**
 * 路径参数类型校验（值可能已被路由转换为 number / boolean）
 *
 * @param {any} value 字段值
 * @param {string} type 类型名
 * @returns {any} 校验后的值
 */
function validateParam(value, type) {
    if (typeof value === 'string') {
        return validateFromString(value, type);
    }
    return validateStrict(value, type);
}

/**
 * 严格类型校验（JSON 请求体语义：值必须已是目标类型）
 *
 * @param {any} data 字段值
 * @param {string} type 类型名
 * @returns {any} 校验后的值
 */
function validateStrict(data, type) {
    switch (type) {
        case 'string':
            if (typeof data !== 'string') {
                throw typeError(type);
            }
            return data;
        case 'int':
            if (!Number.isInteger(data)) {
                throw typeError(type);
            }
            return data;
        case 'bool':
            if (typeof data !== 'boolean') {
                throw typeError(type);
            }
            return data;
        case 'array':
            // 对象/数组同属"结构"语义，一并接受（对外契约，勿收紧）
            if (!(Array.isArray(data) || (typeof data === 'object' && data !== null))) {
                throw typeError(type);
            }
            return data;
        case 'float':
            if (typeof data === 'number') {
                return data;
            }
            if (typeof data === 'string' && isNumericString(data)) {
                return Number(data);
            }
            throw typeError(type);
        default:
            return data;
    }
}

/**
 * 字符串来源类型校验（query / param 的值天然是字符串）
 *
 * @param {string} value 字段值
 * @param {string} type 类型名
 * @returns {any} 校验/强转后的值
 */
function validateFromString(value, type) {
    switch (type) {
        case 'string':
            return value;
        case 'int': {
            if (isNumericString(value) && Number.isInteger(Number(value))) {
                return Number(value);
            }
            throw typeError(type);
        }
        case 'float': {
            if (isNumericString(value)) {
                return Number(value);
            }
            throw typeError(type);
        }
        case 'bool': {
            const parsed = parseBooleanString(value);
            if (parsed === null) {
                throw typeError(type);
            }
            return parsed;
        }
        case 'array':
            // 字符串来源不具备数组语义
            throw typeError(type);
        default:
            return value;
    }
}

/**
 * 解析 Cookie 头为键值表
 *
 * @param {string} header Cookie 头原文
 * @returns {Record<string, string>} Cookie 键值表（值已解码）
 */
function parseCookieHeader(header) {
    /** @type {Record<string, string>} */
    const jar = {};
    if (header === '') {
        return jar;
    }
    for (const part of header.split(';')) {
        const index = part.indexOf('=');
        if (index === -1) {
            continue;
        }
        const key = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();
        if (key !== '') {
            try {
                jar[key] = decodeURIComponent(value);
            } catch {
                jar[key] = value;
            }
        }
    }
    return jar;
}
