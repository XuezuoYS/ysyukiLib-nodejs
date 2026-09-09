import { runWithContext } from '#YukiLib/httpServer/context';

/**
 * httpServer 测试夹具：请求上下文、请求替身、响应替身
 *
 * 各用例自包含，不依赖库自身目录下的任何配置文件。
 *
 * @typedef {object} ResStub
 * @property {number} statusCode 已设置的状态码
 * @property {string|undefined} statusMessage 状态描述（响应状态日志取用）
 * @property {Record<string, any>} headers 按写出顺序记录的响应头
 * @property {string[]} cookieLines 追加的 Set-Cookie 行
 * @property {boolean} ended 是否已结束响应
 * @property {boolean} destroyed 是否已被强制断开（响应已开始后异常的兜底分支）
 * @property {string|undefined} body 传入 end() 的响应体
 * @property {Record<string, Function[]>} listeners 事件监听（accessLog 依赖 finish）
 * @property {(name: string, value: any) => void} setHeader 设置响应头
 * @property {(name: string) => any} getHeader 读取响应头
 * @property {(name: string, value: string) => void} appendHeader 追加响应头
 * @property {(event: string, listener: Function) => void} on 注册事件监听
 * @property {(event: string) => void} emit 触发事件
 * @property {() => void} destroy 强制断开响应
 * @property {(chunk?: string) => void} end 结束响应
 */

/**
 * 构造响应替身（统一出口只用到 statusCode / statusMessage / setHeader / appendHeader / end）
 *
 * @default options = {}
 * @param {object} [options] 选项
 * @param {string} [options.statusMessage] 状态描述（默认 undefined，按标准 reason phrase 取）
 * @returns {ResStub} 替身
 */
export function makeResStub(options = {}) {
    const { statusMessage = undefined } = options;
    const stub = {
        statusCode: 200,
        statusMessage,
        /** @type {Record<string, any>} */
        headers: {},
        /** @type {string[]} */
        cookieLines: [],
        ended: false,
        destroyed: false,
        /** @type {string|undefined} */
        body: undefined,
        /** @type {Record<string, Function[]>} 事件监听（accessLog 依赖 finish） */
        listeners: {},
        /**
         * @param {string} name 头名
         * @param {any} value 头值
         */
        setHeader(name, value) {
            this.headers[name] = value;
        },
        /**
         * @param {string} event 事件名
         * @param {Function} listener 监听函数
         */
        on(event, listener) {
            (this.listeners[event] ??= []).push(listener);
        },
        /**
         * @param {string} event 事件名
         */
        emit(event) {
            for (const listener of this.listeners[event] ?? []) {
                listener();
            }
        },
        /**
         * @param {string} name 头名
         * @returns {any} 头值
         */
        getHeader(name) {
            return this.headers[name];
        },
        /**
         * @param {string} name 头名
         * @param {string} value 头值
         */
        appendHeader(name, value) {
            if (name === 'Set-Cookie') {
                this.cookieLines.push(value);
                this.headers[name] = this.cookieLines.length === 1 ? value : [...this.cookieLines];
                return;
            }
            // 与 node ServerResponse 一致：非 Set-Cookie 头按 ', ' 追加而非覆盖
            const previous = this.headers[name];
            this.headers[name] = previous === undefined ? value : `${previous}, ${value}`;
        },
        /**
         * 强制断开响应（响应已开始后异常的兜底分支依赖）
         */
        destroy() {
            this.destroyed = true;
        },
        /**
         * @param {string} [chunk] 响应体
         */
        end(chunk) {
            this.ended = true;
            this.body = chunk;
            this.emit('finish');
        },
    };
    return /** @type {ResStub} */ (/** @type {unknown} */ (stub));
}

/**
 * 构造请求替身
 *
 * @default options = {}
 * @param {object} [options] 选项
 * @param {Record<string, any>} [options.headers] 请求头（键小写）
 * @param {string} [options.remoteAddress] socket 远端地址
 * @param {string} [options.url] 原始请求目标（req.url，含查询串与 hash）
 * @returns {import('node:http').IncomingMessage} 请求替身
 */
export function makeReqStub(options = {}) {
    const { headers = {}, remoteAddress = '127.0.0.1', url = '/' } = options;
    return /** @type {import('node:http').IncomingMessage} */ (/** @type {unknown} */ ({
        headers,
        socket: { remoteAddress },
        url,
    }));
}

/**
 * 构造请求上下文
 *
 * @default options = {}
 * @param {object} [options] 选项
 * @param {string} [options.method] HTTP 方法
 * @param {string} [options.path] 请求路径
 * @param {Record<string, string|number|boolean>} [options.params] 路径参数
 * @param {Record<string, string>} [options.query] 查询参数
 * @param {Record<string, any>} [options.body] 已解析请求体
 * @param {'json'|'form'} [options.bodySource] 请求体来源（决定 getPostData 校验语义）
 * @param {string} [options.rawBody] 请求体原文
 * @param {Record<string, any>} [options.headers] 请求头
 * @param {string} [options.requestId] 请求标识
 * @param {string} [options.url] 原始请求目标（req.url，含查询串与 hash）
 * @param {ResStub} [options.res] 响应替身
 * @param {import('#YukiLib/httpServer/serverLogger').ServerLoggerRequestLog} [options.logger] 请求级日志替身
 * @returns {import('#YukiLib/httpServer/context').HttpContext} 请求上下文
 */
export function makeCtx(options = {}) {
    const {
        method = 'POST',
        path = '/',
        params = {},
        query = {},
        body = {},
        bodySource = 'json',
        rawBody = '',
        headers = {},
        requestId = 'req-test-1',
        url = '/',
        res = makeResStub(),
        logger = { info() {}, warn() {}, error() {}, access() {}, response() {} },
    } = options;
    return /** @type {import('#YukiLib/httpServer/context').HttpContext} */ (/** @type {unknown} */ ({
        req: makeReqStub({ headers, url }),
        res,
        method,
        path,
        params,
        query: new URLSearchParams(query),
        body,
        bodySource,
        rawBody,
        requestId,
        state: {},
        logger,
    }));
}

/**
 * 在指定上下文中执行
 *
 * @template T
 * @param {import('#YukiLib/httpServer/context').HttpContext} ctx 上下文
 * @param {() => T} handler 处理函数
 * @returns {T} 处理结果
 */
export function runIn(ctx, handler) {
    return runWithContext(ctx, handler);
}
