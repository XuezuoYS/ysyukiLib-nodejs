import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';

import { Config } from './config.js';

/**
 * 响应元信息（传输层观测值，非 HTTP 契约字段）
 *
 * @typedef {object} HttpClientRawInfo
 * @property {string} url 最终 URL（重定向后）
 * @property {number} http_code 最终响应状态码
 * @property {string} content_type 响应 Content-Type（缺省空串）
 * @property {number} num_redirects 实际跟随的重定向次数
 * @property {number} total_time 总耗时（秒）
 */

/**
 * HTTP 客户端类（node:http / node:https 自研封装，不引第三方）
 *
 * 支持 GET、POST、PUT、DELETE 等常见 HTTP 方法；
 * 支持 HTTPS 请求与 SSL 证书校验（自定义 CA：宿主项目根下 `CA/cacert.pem`，校验默认开启）。
 *
 * 行为约定（既定契约）：
 * - `requireHttp(method, url, headers, data)` 返回 `{ status, headers, body, rawInfo }`；
 * - 无协议前缀的 URL 自动补 `http://`（safeUrl）；url 入参支持 `URL` 对象等非字符串（内部归一化）；
 * - 3xx 自动重定向（上限 10 次，自动 Referer；协议按每一跳的 URL 重新判定，可跨 http/https；
 *   POST 遇 301/302/303 转 GET 并丢弃请求体，307/308 保持方法）；
 * - 总超时 60s、连接超时 20s；
 * - 请求结束后清空累积请求头（实例默认头不跨请求保留）；
 * - headers 为 null 时使用 headerAdd 累积的实例头；数字键（或数组项）按原始 "Name: value" 行解析；
 * - 同一实例支持并发请求：每次请求在入口处把"实例累积头 + 调用方头"合成为**本次请求私有**的头集合，
 *   调用方头不回写 `this.headers`，实例累积头只作默认值被只读快照（并发请求互不污染，
 *   租户密钥、Authorization 等凭据不会串到别的请求上）；
 * - 每个请求的头集合在入口处一次成型，重定向各跳只在该请求私有副本上追加 Referer。
 *
 * 其它约定（不影响业务契约）：
 * - 响应头键名为小写（node 规范）；
 * - 响应体按 UTF-8 解码为字符串；
 * - 自定义 CA 文件缺失时回退系统 CA（通用库不因宿主缺少 CA 文件而失败）；
 *   自定义 CA 路径可用 HttpClient.caFilePath 重定向，赋值后下次 HTTPS 请求即生效；
 *   注意 `https.Agent` 的 `ca` 是**替换**内置根证书列表而非追加——只有确实需要
 *   信任私有 CA 时才配置该文件；同一路径下替换证书内容需 `closeAgents()` 重新读取。
 * - 响应体默认全量缓冲；`HttpClient.maxBodyMb` 可设置单个响应体大小上限（MB，0 为无限制），
 *   超限抛 `HTTP Request Failed: 响应体过大（上限 N MB）`。
 *
 * 常用函数：
 * - requireHttp(method, url, headers, data):发起 HTTP 请求
 * - get(url, headers) / post(url, data, dataType, headers) / put(url, data, dataType, headers) / delete(url, headers)
 *
 */

/** 总超时（秒） */
const TOTAL_TIMEOUT_MS = 60_000;
/** 连接超时（秒） */
const CONNECT_TIMEOUT_MS = 20_000;
/** 最大重定向次数 */
const MAX_REDIRECTS = 10;

/**
 * 自定义 CA 证书内容（懒加载缓存；null 表示尚未加载或文件缺失）
 * @type {string|null}
 */
let caCertPem = null;

/**
 * 已加载 CA 的路径（null 表示尚未加载）
 *
 * 缓存键：`HttpClient.caFilePath` 变更时据此判定需要重新加载，
 * 避免"改了路径仍用旧证书/旧 Agent"。
 * @type {string|null}
 */
let caLoadedPath = null;

/**
 * 进程级连接复用 Agent（DNS/连接复用）
 * @type {{http: http.Agent, https: https.Agent|null}}
 */
const agents = {
    http: new http.Agent({ keepAlive: true }),
    https: null,
};

/**
 * 加载自定义 CA 证书内容（缺失或不可读时返回 null，回退系统 CA）
 *
 * @param {string} file 证书文件路径
 * @returns {string|null} PEM 内容，或 null
 */
function loadCaCert(file) {
    try {
        return readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}

/**
 * 按当前 caFilePath 加载 CA 并重建 HTTPS Agent
 *
 * 路径未变且已加载过时复用现有 Agent（连接可继续复用）；
 * 路径变化则丢弃旧 Agent 并按新路径重新加载——否则改了 caFilePath
 * 仍会沿用首次的证书，且调用方无从察觉。
 *
 * @returns {https.Agent} HTTPS Agent
 */
function reloadHttpsAgent() {
    const file = HttpClient.caFilePath;
    if (caLoadedPath === file && agents.https !== null) {
        return agents.https;
    }

    if (agents.https !== null) {
        agents.https.destroy();
    }
    caLoadedPath = file;
    caCertPem = loadCaCert(file);
    agents.https = caCertPem === null
        ? new https.Agent({ keepAlive: true })
        : new https.Agent({ keepAlive: true, ca: caCertPem });
    return agents.https;
}

/**
 * 获取启用自定义 CA 的 HTTPS Agent（懒创建；路径变化时自动重建）
 *
 * @returns {https.Agent} HTTPS Agent
 */
function getHttpsAgent() {
    return reloadHttpsAgent();
}

/**
 * 读取当前响应体上限（字节，0 表示无限制）
 *
 * 每次请求（重定向的每一跳）读取一次；非法值（负数、NaN、非数字）按无限制处理。
 *
 * @returns {number} 字节上限；0 为无限制
 */
function maxBodyBytes() {
    const mb = Number(HttpClient.maxBodyMb);
    return Number.isFinite(mb) && mb > 0 ? Math.floor(mb * 1024 * 1024) : 0;
}

/**
 * 将实例/调用方请求头规范化为 node 外发头对象
 *
 * 数字键按原始 "Name: value" 行解析
 *
 * @param {Record<string, any>|Array<string>|null} headers 请求头
 * @returns {Record<string, string>} 规范化请求头
 */
function toOutboundHeaders(headers) {
    /** @type {Record<string, string>} */
    const out = {};
    if (headers === null || headers === undefined) {
        return out;
    }
    for (const [key, value] of Object.entries(headers)) {
        if (/^\d+$/.test(key)) {
            const raw = String(value);
            const index = raw.indexOf(':');
            if (index !== -1) {
                out[raw.slice(0, index).trim()] = raw.slice(index + 1).trim();
            }
        } else {
            out[key] = String(value);
        }
    }
    return out;
}

/**
 * 判断规范化请求头中是否已存在某个头名（大小写不敏感）
 *
 * 请求头名按 HTTP 语义大小写不敏感，而 `toOutboundHeaders` 产出的键保留了调用方写法
 * （`Content-Type` / `content-type` / 原始行解析出的名字都可能出现），
 * 因此补默认头前必须逐个键小写比对，否则同名头会重复外发。
 *
 * @param {Record<string, string>} headers 规范化请求头
 * @param {string} name 头名
 * @returns {boolean} 是否已存在
 */
function hasHeaderName(headers, name) {
    const lower = name.toLowerCase();
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === lower) {
            return true;
        }
    }
    return false;
}

/**
 * 单次请求（不含重定向循环），Promise 化 node http/https 请求
 *
 * @param {string} method HTTP 方法
 * @param {URL} target 请求目标
 * @param {Record<string, string>} headers 规范化请求头
 * @param {string|Buffer|null} body 请求体
 * @param {boolean} isSSL 是否 HTTPS
 * @param {AbortSignal} signal 总超时信号
 * @returns {Promise<{status: number, headers: Record<string, string>, body: string, location: string|undefined}>} 响应
 */
function requestOnce(method, target, headers, body, isSSL, signal) {
    return new Promise((resolve, reject) => {
        const lib = isSSL ? https : http;
        const options = {
            protocol: isSSL ? 'https:' : 'http:',
            hostname: target.hostname,
            port: target.port === '' ? undefined : Number(target.port),
            method,
            path: `${target.pathname}${target.search}`,
            headers: { ...headers, Host: target.host },
            agent: isSSL ? getHttpsAgent() : agents.http,
            timeout: CONNECT_TIMEOUT_MS,
            signal,
        };

        const req = lib.request(options, (res) => {
            const maxBytes = maxBodyBytes();
            /** @type {Buffer[]} */
            const chunks = [];
            let size = 0;
            res.on('data', (chunk) => {
                size += chunk.length;
                if (maxBytes > 0 && size > maxBytes) {
                    // 超限先给出明确错误（后续事件不再覆盖），再断链，避免继续读入内存
                    const err = new Error(`响应体过大（上限 ${HttpClient.maxBodyMb} MB）`);
                    reject(err);
                    req.destroy(err);
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', () => {
                /** @type {Record<string, string>} */
                const responseHeaders = {};
                for (const [key, value] of Object.entries(res.headers)) {
                    if (value !== undefined) {
                        responseHeaders[key] = Array.isArray(value) ? value.join(', ') : String(value);
                    }
                }
                resolve({
                    status: res.statusCode ?? 0,
                    headers: responseHeaders,
                    body: Buffer.concat(chunks).toString('utf8'),
                    location: res.headers.location,
                });
            });
            res.on('error', reject);
        });

        // node 的 timeout 选项在连接建立后语义为"空闲超时"，此处用于连接阶段
        req.on('timeout', () => {
            req.destroy(new Error(`连接超时（${CONNECT_TIMEOUT_MS / 1000}s）`));
        });
        req.on('error', reject);

        if (body !== null && body !== undefined && method !== 'GET') {
            req.end(body);
        } else {
            req.end();
        }
    });
}

export class HttpClient {
    /**
     * 最近一次请求的 URL（实例状态，便于排障时查看）
     *
     * 仅为观测值：同实例并发请求由最后写入者决定，不保证归属于某一次请求；
     * 某次请求的最终 URL 取该次返回值的 `rawInfo.url`。
     * @type {string}
     */
    url = '';

    /**
     * 累积请求头（实例级默认头：跨方法合并，单次请求结束清空）
     *
     * 请求发起时只被读取（快照进本次请求私有的头集合），调用方头不回写到此处，
     * 因此同实例并发请求之间不会互相污染。
     * @type {Record<string, any>}
     */
    headers = {};

    /**
     * 最近一次请求是否为 SSL（实例状态，随每一跳更新；
     * 重定向跨协议时以最后一跳为准；并发请求下同样是观测值，不作为发请求的依据——
     * 每一跳实际用 http 还是 https 由该跳 URL 的协议在请求私有上下文里判定）
     * @type {boolean}
     */
    ssl = false;

    /**
     * 显式指定的自定义 CA 证书路径（null 表示宿主项目根下 CA/cacert.pem）
     * @type {string|null}
     */
    static #caFilePath = null;

    /**
     * 自定义 CA 证书路径（默认宿主项目根下 `CA/cacert.pem`，可显式赋值重定向）
     *
     * 赋值后下一次 HTTPS 请求即按新路径重新加载 CA 并重建 Agent，
     * 无需再手动调用 `closeAgents()`；若只是**同一路径下替换了证书内容**，
     * 仍需 `closeAgents()` 才会重新读取。
     *
     * @returns {string} 证书文件绝对路径
     */
    static get caFilePath() {
        return HttpClient.#caFilePath ?? Config.resolveFromRoot('CA', 'cacert.pem');
    }

    /**
     * @param {string|null} file 证书文件路径
     */
    static set caFilePath(file) {
        HttpClient.#caFilePath = file === null ? null : String(file);
        // 丢弃旧 CA 与 Agent：下次请求按新路径重新加载（Agent 懒重建）
        caCertPem = null;
        caLoadedPath = null;
        if (agents.https !== null) {
            agents.https.destroy();
            agents.https = null;
        }
    }

    /**
     * 单个响应体大小上限（MB），0 表示无限制（默认）
     *
     * 按单个响应计：重定向链的每一跳各自适用；超限抛
     * `HTTP Request Failed: 响应体过大（上限 N MB）`，超出部分不会读入内存。
     * @type {number}
     */
    static maxBodyMb = 0;

    /**
     * 安全化URL处理函数
     *
     * 该函数用于确保URL具有正确的协议前缀，如果URL没有http或https协议，则默认添加http协议前缀
     *
     * 入参按 `String()` 归一化，`URL` 对象、数字等非字符串入参不会抛 `url.trim is not a function`；
     * 空串/null 补前缀后成为 `http://`，交由后续 `new URL()` 报出明确的 URL 解析错误。
     *
     * @param {string|URL|any} url 需要处理的URL（URL 对象等会先转字符串）
     * @returns {string} 处理后的安全URL
     */
    safeUrl(url) {
        let safe = String(url ?? '').trim();
        if (!/^https?:\/\//i.test(safe)) {
            safe = 'http://' + safe;
        }
        return safe;
    }

    /**
     * 检查URL是否使用SSL加密协议
     *
     * 通过正则匹配URL是否以https://开头来判断是否为SSL加密连接，
     * 并把判断结果写回实例状态（http 会把 ssl 复位为 false，不保留上一次的 https 状态）
     *
     * @param {string|URL|any} url 待检查URL（非字符串入参会先转字符串）
     * @returns {boolean} 返回true表示URL使用SSL加密，false表示未使用SSL加密
     */
    isSSL(url) {
        const isSsl = /^https:/i.test(String(url ?? ''));
        this.ssl = isSsl;
        return isSsl;
    }

    /**
     * 添加HTTP请求头（实例级默认头）
     *
     * 该函数用于添加HTTP请求头，参数为对象，键为请求头名称，值为请求头值；
     * 亦接受数组形式（元素为 "名称: 值" 原始行）
     *
     * 累积头是**该实例下一次请求的默认头**：请求发起时按只读快照取用，
     * 请求结束（含失败）后清空，不跨请求保留。只属于某一次请求的头
     * （租户密钥、单次凭据等）应经 `requireHttp`/`get`/`post` 的 headers 入参传入，
     * 而不要写进这里——实例头是共享状态，同一实例上并发的其它请求会取到它。
     *
     * @param {Record<string, any>|Array<string>} headers 请求头
     * @returns {boolean} 添加成功返回true，失败返回false
     */
    headerAdd(headers) {
        this.headers = { ...this.headers, ...headers };
        return true;
    }

    /**
     * 清空请求头
     */
    clearHeader() {
        this.headers = {};
    }

    /**
     * 发起HTTP请求（含自动重定向）
     *
     * 并发安全：同一实例可同时发起多个请求，各自的 headers 入参只作用于本次请求
     * （详见类注释的行为约定）。
     *
     * @param {string} method 请求方法，如GET、POST、PUT、DELETE等
     * @param {string|URL|any} url 请求URL（URL 对象等非字符串会经 safeUrl 归一化）
     * @param {Record<string, any>|Array<string>|null} [headers] 添加请求头，为 null 时使用实例累积的请求头
     * @default headers = null
     * @param {string|Buffer|null} [data] 请求数据，字符串/Buffer 原样发送；GET 方法不发送请求体
     * @default data = null
     * @returns {Promise<{status: number, headers: Record<string, string>, body: string, rawInfo: HttpClientRawInfo}>} 请求结果
     */
    async requireHttp(method, url, headers = null, data = null) {
        return this.#requireHttp(method, url, headers, data, null);
    }

    /**
     * 请求实现（可附带"由请求体推导的默认 Content-Type"）
     *
     * @param {string} method 请求方法
     * @param {string|URL|any} url 请求URL（URL 对象等非字符串会经 safeUrl 归一化）
     * @param {Record<string, any>|Array<string>|null} headers 调用方请求头，null 表示只用实例累积头
     * @param {string|Buffer|null} data 请求体
     * @param {string|null} bodyContentType 由 dataType 推导的 Content-Type；调用方已声明时不覆盖
     * @returns {Promise<{status: number, headers: Record<string, string>, body: string, rawInfo: HttpClientRawInfo}>} 请求结果
     */
    async #requireHttp(method, url, headers, data, bodyContentType) {
        url = this.safeUrl(url);
        this.url = url;

        // 本次请求私有的头集合：实例累积头作默认值，调用方头覆盖之。
        // 只读快照、不回写 this.headers——写回会让同实例并发请求互相污染（凭据跨请求泄漏）。
        const outbound = toOutboundHeaders(
            headers === null ? this.headers : { ...this.headers, ...headers },
        );
        if (bodyContentType !== null && !hasHeaderName(outbound, 'Content-Type')) {
            outbound['Content-Type'] = bodyContentType;
        }

        const upperMethod = String(method).toUpperCase();

        // 总超时，跨全部重定向共享同一期限
        const controller = new AbortController();
        const deadline = setTimeout(() => {
            controller.abort(new Error(`请求超时（${TOTAL_TIMEOUT_MS / 1000}s）`));
        }, TOTAL_TIMEOUT_MS);
        const startedAt = Date.now();

        try {
            let target = new URL(url);
            let currentMethod = upperMethod;
            let currentBody = data === null || data === undefined ? null : data;
            let redirectCount = 0;
            let response = null;
            let finalUrl = target.href;

            for (;;) {
                // 协议按每一跳的 URL 判定：重定向可跨 http/https，不能沿用初始 URL 的判定
                const hopIsSSL = target.protocol === 'https:';
                this.ssl = hopIsSSL;
                response = await requestOnce(currentMethod, target, outbound, currentBody, hopIsSSL, controller.signal);
                finalUrl = target.href;

                const status = response.status;
                const isRedirect = status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
                if (!isRedirect || !response.location || redirectCount >= MAX_REDIRECTS) {
                    break;
                }

                // 自动重定向：自动补充 Referer（写在本次请求私有的头集合上，
                // 不影响同实例其它请求，也不影响下一跳之外的共享状态）
                outbound.Referer = target.href;
                redirectCount += 1;

                // POST 遇 301/302/303 降级为 GET 并丢弃请求体；307/308 保持方法
                if (status === 303 || ((status === 301 || status === 302) && currentMethod === 'POST')) {
                    currentMethod = 'GET';
                    currentBody = null;
                }

                target = new URL(response.location, target);
            }

            return {
                status: response.status,
                headers: response.headers,
                body: response.body,
                rawInfo: {
                    url: finalUrl,
                    http_code: response.status,
                    content_type: response.headers['content-type'] ?? '',
                    num_redirects: redirectCount,
                    total_time: (Date.now() - startedAt) / 1000,
                },
            };
        } catch (err) {
            const cause = err instanceof Error && err.name === 'AbortError'
                ? controller.signal.reason ?? err
                : err;
            throw new Error(`HTTP Request Failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
        } finally {
            clearTimeout(deadline);
            // 请求结束清空累积请求头
            this.clearHeader();
        }
    }

    /**
     * 发送GET请求
     *
     * 该函数用于发送GET请求，参数为URL和请求头，返回请求结果
     *
     * @param {string|URL|any} url 请求URL（URL 对象等非字符串会经 safeUrl 归一化）
     * @param {Record<string, any>|Array<string>|null} [headers] 请求头，为 null 时使用实例累积的请求头
     * @default headers = null
     * @returns {Promise<{status: number, headers: Record<string, string>, body: string, rawInfo: HttpClientRawInfo}>} 请求结果
     */
    get(url, headers = null) {
        return this.requireHttp('GET', url, headers);
    }

    /**
     * 发送POST请求
     *
     * 该函数用于发送POST请求，参数为URL、数据、数据类型和请求头，返回请求结果
     *
     * @param {string|URL|any} url 请求URL（URL 对象等非字符串会经 safeUrl 归一化）
     * @param {any} [data] 请求数据，对象/数组按 dataType 自动转换，字符串原样发送
     * @default data = []
     * @param {string} [dataType] 数据类型，可选 "json" 或 "form"
     * @default dataType = 'json'
     * @param {Record<string, any>|Array<string>|null} [headers] 请求头，为 null 时使用实例累积的请求头
     * @default headers = null
     * @returns {Promise<{status: number, headers: Record<string, string>, body: string, rawInfo: HttpClientRawInfo}>} 请求结果
     */
    post(url, data = [], dataType = 'json', headers = null) {
        return this.#withBody('POST', url, data, dataType, headers);
    }

    /**
     * 发送PUT请求
     *
     * 该函数用于发送PUT请求，参数为URL、数据、数据类型和请求头，返回请求结果
     *
     * @param {string|URL|any} url 请求URL（URL 对象等非字符串会经 safeUrl 归一化）
     * @param {any} [data] 请求数据，对象/数组按 dataType 自动转换，字符串原样发送
     * @default data = []
     * @param {string} [dataType] 数据类型，可选 "json" 或 "form"
     * @default dataType = 'json'
     * @param {Record<string, any>|Array<string>|null} [headers] 请求头，为 null 时使用实例累积的请求头
     * @default headers = null
     * @returns {Promise<{status: number, headers: Record<string, string>, body: string, rawInfo: HttpClientRawInfo}>} 请求结果
     */
    put(url, data = [], dataType = 'json', headers = null) {
        return this.#withBody('PUT', url, data, dataType, headers);
    }

    /**
     * 发送DELETE请求
     *
     * 该函数用于发送DELETE请求，参数为URL和请求头，返回请求结果
     *
     * @param {string|URL|any} url 请求URL（URL 对象等非字符串会经 safeUrl 归一化）
     * @param {Record<string, any>|Array<string>|null} [headers] 请求头，为 null 时使用实例累积的请求头
     * @returns {Promise<{status: number, headers: Record<string, string>, body: string, rawInfo: HttpClientRawInfo}>} 请求结果
     */
    delete(url, headers = null) {
        return this.requireHttp('DELETE', url, headers);
    }

    /**
     * 按 dataType 组织请求体并发起请求
     *
     * @param {string} method HTTP 方法
     * @param {string|URL|any} url 请求URL（URL 对象等非字符串会经 safeUrl 归一化）
     * @param {any} data 请求数据
     * @param {string} dataType "json" 或 "form"
     * @param {Record<string, any>|Array<string>|null} headers 请求头
     * @returns {Promise<{status: number, headers: Record<string, string>, body: string, rawInfo: HttpClientRawInfo}>} 请求结果
     */
    #withBody(method, url, data, dataType, headers) {
        let body = data;
        /** @type {string|null} */
        let bodyContentType = null;
        if (data !== null && typeof data === 'object') {
            if (dataType === 'json') {
                body = JSON.stringify(data);
                bodyContentType = 'application/json';
            } else if (dataType === 'form') {
                const params = new URLSearchParams();
                for (const [key, value] of Object.entries(data)) {
                    params.append(key, String(value));
                }
                body = params.toString();
                bodyContentType = 'application/x-www-form-urlencoded';
            }
        }
        // 经参数传递而非 headerAdd：写进实例头会让并发请求带上本次的 Content-Type
        return this.#requireHttp(method, url, headers, body, bodyContentType);
    }

    /**
     * 释放进程级连接复用 Agent（优雅退出/测试收尾时调用）
     *
     * HTTPS Agent 与 CA 缓存一并重置：宿主根变化、或**同一路径下证书内容被替换**后，
     * 下次请求会重新读取证书文件。仅改 `HttpClient.caFilePath` 无需调用本方法
     * （赋值时已自动失效）。
     *
     * @returns {void}
     */
    static closeAgents() {
        agents.http.destroy();
        if (agents.https !== null) {
            agents.https.destroy();
        }
        agents.https = null;
        caCertPem = null;
        caLoadedPath = null;
    }
}
