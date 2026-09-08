import { Logger } from '../logger.js';

/**
 * 自研薄路由（FastAPI 风格模板，无第三方依赖）
 *
 * 模板语法（路径段占位符）：
 * - `{name}`：默认字符串段（不含斜杠）；
 * - `{name:type}`：指定类型段，内置 int / float / bool / string / hex / alpha / path / all；
 * - `{name:type?}` 或 `{name?}`：可选段（缺失时该键不出现在 params）；
 * - `{path:path}`：跨斜杠捕获（非贪婪，至少一个字符）；`{rest:all}`：跨斜杠且包含尾斜杠；
 * - `@` 前缀：整条路由按自定义正则匹配（命名组进 params，数字组丢弃；缺锚定时自动补 `^...$`）；
 * - `*`：通配全部路径。
 *
 * 行为约定：
 * - 匹配按注册顺序，先注册先命中；
 * - `match` 返回 `{ status, target, params, name, allowed, middleware }`：
 *   status 为 hit / methodNotAllowed / notFound；路径命中而方法不符时给出 allowed（405 用）；
 * - HEAD 请求可命中 GET 路由（响应体由入口层按 HEAD 语义抑制）；
 * - 默认忽略尾斜杠（`trailingSlash: 'strict'` 可关闭）；
 * - `generate` 默认对参数值做 URL 编码（`{path:path}` / `{rest:all}` 按段编码、保留斜杠），
 *   可用 `generate(name, params, { encode: false })` 关闭；`@` 自定义正则路由不支持反向生成；
 * - 手工拼 URL 时用 `encodeUrlParam(value, { keepSlash })`，与 `generate` 同一套编码规则；
 * - 未知类型在注册时即抛错（自定义类型用 `addMatchTypes` 追加）；
 * - 注册期正则护栏：`@` 模式与自定义类型片段超过 1024 字符直接抛错；疑似灾难性回溯
 *   （嵌套量词，如 `(a+)+`）仅 `Logger.warn` 提醒——该启发式存在误报（如 `(?:[0-9]+\.)+` 安全），
 *   故不阻断注册。
 *
 * 契约（安全红线）：`@` 正则与 `addMatchTypes` 片段必须是**静态、由开发者编写**的字符串，
 * 禁止拼接请求数据；同步正则一旦灾难性回溯会占满事件循环，导致整个服务不可用。
 * 需要匹配用户提供的模式时，请先做白名单或转义。
 *
 * 中间件：`use(...)` 注册全局中间件（分发时组合）；在 `group()` 内注册的中间件
 * 绑定到该分组后续注册的路由；`options.middleware` 绑定单条路由。
 *
 * @typedef {(ctx: any, next: () => Promise<void>) => any} RouteMiddleware
 * @typedef {{name?: string|null, middleware?: RouteMiddleware[]}} RouteOptions
 * @typedef {object} RouteEntry
 * @property {string[]} methods 允许的方法（`*` 表示全部）
 * @property {string} route 注册时的路由模式
 * @property {Function} target 处理器
 * @property {string|null} name 路由名
 * @property {RegExp|null} regex 编译后的正则（无占位符时为 null）
 * @property {Record<string, string>} paramTypes 各路径参数的类型
 * @property {RouteMiddleware[]} middleware 该路由绑定的中间件
 * @typedef {{status: 'hit'|'methodNotAllowed'|'notFound', target: Function|null, params: Record<string, string|number|boolean>, name: string|null, allowed: string[], middleware: RouteMiddleware[]}} RouteMatch
 */

/**
 * 内置类型（正则片段）
 * @type {Record<string, string>}
 */
const DEFAULT_TYPES = {
    int: '[0-9]+',
    float: '[0-9]+(?:\\.[0-9]+)?',
    bool: '(?:true|false)',
    string: '[^/]+',
    hex: '[0-9A-Fa-f]+',
    alpha: '[0-9A-Za-z]+',
    path: '.+?',
    all: '.+',
};

/**
 * 模板块匹配模式：前缀（`/` 或 `.`）+ `{name[:type][?]}`
 */
const BLOCK_PATTERN = /(\/|\.|)\{([^}:?]*)(?::([^}?]+))?(\?)?\}/g;

/** 正则源长度上限（`@` 模式与自定义类型片段；超长几乎必然是拼接产物） */
const MAX_PATTERN_LENGTH = 1024;

/**
 * 疑似灾难性回溯的启发式：被量词的组内部又含量词（如 `(a+)+`、`(.*)*`）
 *
 * 存在误报（如 `(?:[0-9]+\.)+` 实际安全），故命中时只告警、不阻断注册。
 */
const NESTED_QUANTIFIER_PATTERN = /\((?:\?:)?[^()]*[+*][^()]*\)\s*[+*{]/;

/** 护栏告警用的子 logger（等级固定 warn，生产环境也记录） */
const PATTERN_GUARD_LOG = Logger.create({ level: 'warn' });

/**
 * 注册期正则护栏
 *
 * 超长直接抛错（服务端配置错误）；疑似灾难性回溯仅告警，避免误报阻断合法路由。
 *
 * @param {string} source 正则源（`@` 模式或自定义类型片段）
 * @param {string} origin 来源描述（错误与日志用）
 * @throws {Error} 正则源超过 MAX_PATTERN_LENGTH
 */
function guardPattern(source, origin) {
    if (source.length > MAX_PATTERN_LENGTH) {
        throw new Error(`路由正则过长（${source.length} > ${MAX_PATTERN_LENGTH}）：${origin}`);
    }
    if (NESTED_QUANTIFIER_PATTERN.test(source)) {
        PATTERN_GUARD_LOG.warn('路由正则疑似灾难性回溯（嵌套量词），请确认模式不含用户输入', { origin, source });
    }
}

/**
 * URL 参数编码（反向路由与手工拼 URL 共用）
 *
 * 把变量安全地拼进 URL：编码后 `#` / `?` / `/` / 空格等结构字符变成 `%XX`，
 * 不会再被解析成 URL 结构（`#` 之后的内容原本根本不会发给服务器）。
 * 默认整段编码；`keepSlash: true` 保留 `/` 作为分隔符（跨斜杠类型 `{path:path}` / `{rest:all}` 用）。
 *
 * @param {any} value 原始值（非字符串经 String() 转换）
 * @param {object} [options] 选项
 * @param {boolean} [options.keepSlash] 是否保留斜杠作为路径分隔符
 * @default options = {}
 * @returns {string} 已编码的 URL 片段
 */
export function encodeUrlParam(value, options = {}) {
    const text = String(value);
    return options.keepSlash === true
        ? text.split('/').map((segment) => encodeURIComponent(segment)).join('/')
        : encodeURIComponent(text);
}

/**
 * 按位置一次性应用替换（从后往前，避免下标位移）
 *
 * @param {string} source 原串
 * @param {{start: number, end: number, text: string}[]} edits 替换项（按任意顺序，互不重叠）
 * @returns {string} 替换结果
 */
function applyEdits(source, edits) {
    const sorted = [...edits].sort((a, b) => b.start - a.start);
    let result = source;
    for (const edit of sorted) {
        result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    }
    return result;
}

/**
 * 补锚定（`@` 模式缺 `^` / `$` 时补上；已有则不重复）
 *
 * @param {string} source 正则源
 * @returns {string} 锚定后的正则源
 */
function anchorPattern(source) {
    return `${source.startsWith('^') ? '' : '^'}${source}${source.endsWith('$') ? '' : '$'}`;
}

export class Router {
    /**
     * 全部路由
     * @type {RouteEntry[]}
     */
    routes = [];

    /**
     * 命名路由表（routeName -> route）
     * @type {Record<string, string>}
     */
    namedRoutes = {};

    /**
     * 忽略请求 URL 的开头部分（应用位于子目录时）
     * @type {string}
     */
    basePath = '';

    /**
     * 尾斜杠策略：ignore（默认，忽略）/ strict（严格）
     * @type {'ignore'|'strict'}
     */
    trailingSlash = 'ignore';

    /**
     * 类型表
     * @type {Record<string, string>}
     */
    matchTypes = { ...DEFAULT_TYPES };

    /**
     * 全局中间件（分发时组合，注册顺序即执行顺序）
     * @type {RouteMiddleware[]}
     */
    globalMiddleware = [];

    /**
     * 分组栈（`group()` 内部有效）
     * @type {Array<{prefix: string, middleware: RouteMiddleware[]}>}
     */
    #groupStack = [];

    /**
     * @param {object} [options] 选项
     * @param {Array<[string, string, Function, (string|RouteOptions)?]>} [options.routes] 批量路由
     * @param {string} [options.basePath] 基础路径
     * @param {'ignore'|'strict'} [options.trailingSlash] 尾斜杠策略
     * @param {Record<string, string>} [options.types] 追加/覆盖的匹配类型
     * @default options = {}
     */
    constructor(options = {}) {
        const { routes = [], basePath = '', trailingSlash = 'ignore', types = {} } = options;
        this.addRoutes(routes);
        this.setBasePath(basePath);
        this.trailingSlash = trailingSlash;
        this.addMatchTypes(types);
    }

    /**
     * 获取全部路由（只读视图）
     * @returns {RouteEntry[]} 全部路由
     */
    getRoutes() {
        return this.routes;
    }

    /**
     * 从数组批量添加路由，格式：[[method, route, target, options], ...]
     *
     * @param {Array<[string, string, Function, (string|RouteOptions)?]>} routes 路由数组
     */
    addRoutes(routes) {
        for (const [method, route, target, options] of routes) {
            this.map(method, route, target, options);
        }
    }

    /**
     * 设置基础路径（应用运行于子目录时有用）
     *
     * @param {string} basePath 基础路径
     */
    setBasePath(basePath) {
        this.basePath = basePath;
    }

    /**
     * 追加命名匹配类型（同名键会被覆盖）
     *
     * @param {Record<string, string>} matchTypes 类型表，键为名称，值为正则片段
     */
    addMatchTypes(matchTypes) {
        this.matchTypes = { ...this.matchTypes, ...matchTypes };
    }

    /**
     * 注册中间件（全局；在 `group()` 内注册则绑定该分组）
     *
     * @param {...RouteMiddleware} middlewares 中间件
     */
    use(...middlewares) {
        const current = this.#groupStack[this.#groupStack.length - 1];
        if (current === undefined) {
            this.globalMiddleware.push(...middlewares);
            return;
        }
        current.middleware.push(...middlewares);
    }

    /**
     * 注册分组（共享路径前缀与中间件）
     *
     * @param {string} prefix 路径前缀
     * @param {(router: Router) => void} callback 分组内注册回调（可嵌套）
     */
    group(prefix, callback) {
        this.#groupStack.push({ prefix, middleware: [] });
        try {
            callback(this);
        } finally {
            this.#groupStack.pop();
        }
    }

    /**
     * 将路由映射到目标处理器
     *
     * @param {string} method HTTP 方法，或 `|` 分隔的多方法（GET|POST），`*` 表示全部
     * @param {string} route 路由模式
     * @param {Function} target 处理器 `(ctx) => any`
     * @param {string|RouteOptions|null} [options] 路由名（字符串）或选项对象 `{ name, middleware }`
     * @default options = null
     */
    map(method, route, target, options = null) {
        const { name, middleware } = normalizeOptions(options);
        const prefix = this.#groupStack.map((item) => item.prefix).join('');
        const groupMiddleware = this.#groupStack.flatMap((item) => [...item.middleware]);

        const fullRoute = prefix + route;
        const { regex, paramTypes } = this.compileRoute(fullRoute);

        this.routes.push({
            methods: String(method).toUpperCase().split('|').filter((item) => item !== ''),
            route: fullRoute,
            target,
            name,
            regex,
            paramTypes,
            middleware: [...groupMiddleware, ...middleware],
        });

        if (name) {
            if (Object.prototype.hasOwnProperty.call(this.namedRoutes, name)) {
                throw new Error(`Can not redeclare route '${name}'`);
            }
            this.namedRoutes[name] = fullRoute;
        }
    }

    /**
     * 注册 GET 路由
     *
     * @param {string} route 路由模式
     * @param {Function} target 处理器
     * @param {string|RouteOptions|null} [options] 路由名或选项
     * @default options = null
     */
    get(route, target, options = null) {
        this.map('GET', route, target, options);
    }

    /**
     * 注册 POST 路由
     *
     * @param {string} route 路由模式
     * @param {Function} target 处理器
     * @param {string|RouteOptions|null} [options] 路由名或选项
     * @default options = null
     */
    post(route, target, options = null) {
        this.map('POST', route, target, options);
    }

    /**
     * 注册 PUT 路由
     *
     * @param {string} route 路由模式
     * @param {Function} target 处理器
     * @param {string|RouteOptions|null} [options] 路由名或选项
     * @default options = null
     */
    put(route, target, options = null) {
        this.map('PUT', route, target, options);
    }

    /**
     * 注册 PATCH 路由
     *
     * @param {string} route 路由模式
     * @param {Function} target 处理器
     * @param {string|RouteOptions|null} [options] 路由名或选项
     * @default options = null
     */
    patch(route, target, options = null) {
        this.map('PATCH', route, target, options);
    }

    /**
     * 注册 DELETE 路由
     *
     * @param {string} route 路由模式
     * @param {Function} target 处理器
     * @param {string|RouteOptions|null} [options] 路由名或选项
     * @default options = null
     */
    delete(route, target, options = null) {
        this.map('DELETE', route, target, options);
    }

    /**
     * 注册任意方法的路由
     *
     * @param {string} route 路由模式
     * @param {Function} target 处理器
     * @param {string|RouteOptions|null} [options] 路由名或选项
     * @default options = null
     */
    any(route, target, options = null) {
        this.map('*', route, target, options);
    }

    /**
     * 反向路由：按名称与参数生成 URL
     *
     * 必填参数缺失时抛错（避免静默生成错误 URL）；可选段缺失时连同分隔符一起剥离；
     * 参数值默认经 `encodeUrlParam` 编码（可用 `options.encode: false` 关闭）。
     *
     * @param {string} routeName 路由名称
     * @param {Record<string, any>} [params] 替换占位符的参数
     * @default params = {}
     * @param {object} [options] 选项
     * @param {boolean} [options.encode] 是否编码参数值，默认 true
     * @default options = {}
     * @returns {string} 生成的 URL
     * @throws {Error} 路由名不存在、必填参数缺失，或对 `@` 自定义正则路由调用时抛出
     */
    generate(routeName, params = {}, options = {}) {
        if (!Object.prototype.hasOwnProperty.call(this.namedRoutes, routeName)) {
            throw new Error(`Route '${routeName}' does not exist.`);
        }

        const route = this.namedRoutes[routeName];
        if (route.startsWith('@')) {
            throw new Error(`Route '${routeName}' 使用 @ 自定义正则，不支持反向生成`);
        }

        const { encode = true } = options;
        const url = this.basePath + route;

        // 按**原串位置**一次性替换：不能对"已替换过的 URL"再按块文本查找替换——
        // 注入的值里若恰好含块文本（如 encode:false 时 a='{b}'），会被当成占位符二次替换。
        /** @type {{start: number, end: number, text: string}[]} */
        const edits = [];

        for (const match of url.matchAll(BLOCK_PATTERN)) {
            const [block, prefix, name, type, optional] = match;
            const start = match.index;

            if (name !== '' && Object.prototype.hasOwnProperty.call(params, name)) {
                const raw = String(params[name]);
                const value = encode
                    ? encodeUrlParam(raw, { keepSlash: type === 'path' || type === 'all' })
                    : raw;
                edits.push({ start, end: start + block.length, text: prefix + value });
                continue;
            }

            if (optional === undefined) {
                if (name === '') {
                    edits.push({ start, end: start + block.length, text: '' });
                    continue;
                }
                throw new Error(`Route '${routeName}' requires parameter '${name}'.`);
            }

            // 可选段缺失：连同分隔符一起剥离（block 本身已含前缀）
            edits.push({ start, end: start + block.length, text: '' });
        }

        return applyEdits(url, edits);
    }

    /**
     * 匹配请求 URL 与路由表
     *
     * @param {string} requestUrl 请求路径（可含查询串，会剥离）
     * @param {string} requestMethod HTTP 方法（大小写不敏感）
     * @returns {RouteMatch} 匹配结果
     */
    match(requestUrl, requestMethod) {
        const method = String(requestMethod ?? '').toUpperCase();
        const url = this.#prepareUrl(requestUrl);
        /** @type {Set<string>} */
        const allowed = new Set();

        // basePath 不匹配（null）时直接 404：连 `*` 通配路由也不参与
        if (url !== null) {
            for (const route of this.routes) {
                const params = this.#matchRoute(route, url);
                if (params === null) {
                    continue;
                }

                if (!matchesMethod(route.methods, method)) {
                    for (const item of route.methods) {
                        if (item !== '*') {
                            allowed.add(item);
                        }
                    }
                    continue;
                }

                return {
                    status: 'hit',
                    target: route.target,
                    params,
                    name: route.name,
                    allowed: [],
                    middleware: route.middleware,
                };
            }
        }

        if (allowed.size > 0) {
            return {
                status: 'methodNotAllowed',
                target: null,
                params: {},
                name: null,
                allowed: [...allowed],
                middleware: [],
            };
        }
        return { status: 'notFound', target: null, params: {}, name: null, allowed: [], middleware: [] };
    }

    /**
     * 编译路由的正则（map 时调用一次并缓存）
     *
     * 无占位符且非 `@` 自定义正则时返回 regex: null（走字符串比较）；
     * `@` 模式缺锚定时自动补 `^...$`，并对模式与自定义类型片段做注册期护栏。
     *
     * @param {string} route 路由模式
     * @returns {{regex: RegExp|null, paramTypes: Record<string, string>}} 锚定正则与参数类型表
     * @throws {Error} 未知类型，或正则源超过长度上限
     */
    compileRoute(route) {
        if (route.startsWith('@')) {
            const source = route.slice(1);
            guardPattern(source, `@${source}`);
            return { regex: new RegExp(anchorPattern(source), 'u'), paramTypes: {} };
        }

        if (route === '*' || route.indexOf('{') === -1) {
            return { regex: null, paramTypes: {} };
        }

        // 与 generate 同策略：按原串位置一次性替换，避免"替换结果里含块文本"被二次替换
        /** @type {{start: number, end: number, text: string}[]} */
        const edits = [];
        /** @type {Record<string, string>} */
        const paramTypes = {};

        for (const match of route.matchAll(BLOCK_PATTERN)) {
            const [block, prefix, name, type = 'string', optional] = match;
            const start = match.index;

            if (!Object.prototype.hasOwnProperty.call(this.matchTypes, type)) {
                throw new Error(`未知的路由类型：${type}（可用 addMatchTypes 追加）`);
            }

            const typePattern = this.matchTypes[type];
            guardPattern(typePattern, `类型 ${type}：${typePattern}`);

            if (name !== '') {
                paramTypes[name] = type;
            }

            const prefixRegex = prefix === '.' ? '\\.' : prefix;
            const namePart = name === '' ? '' : `?<${name}>`;
            const blockRegex = `${prefixRegex}(${namePart}${typePattern})`;
            const optionalMark = optional === undefined ? '' : '?';

            edits.push({ start, end: start + block.length, text: `(?:${blockRegex})${optionalMark}` });
        }

        return { regex: new RegExp(`^${applyEdits(route, edits)}$`, 'u'), paramTypes };
    }

    /**
     * 归一化请求 URL（剥离查询串、basePath 与尾斜杠）
     *
     * basePath 只剥离**完整前缀**（等于 basePath，或形如 `basePath/...`）；
     * 前缀不匹配（如 basePath 为 `/sub` 而请求 `/subx`）返回 null，由 match 直接判 404。
     *
     * @param {string} requestUrl 原始请求 URL
     * @returns {string|null} 归一化后的路径；不在 basePath 之下时为 null
     */
    #prepareUrl(requestUrl) {
        let url = requestUrl;

        const queryIndex = url.indexOf('?');
        if (queryIndex !== -1) {
            url = url.slice(0, queryIndex);
        }

        if (this.basePath !== '') {
            if (url === this.basePath) {
                url = '';
            } else if (url.startsWith(this.basePath + '/')) {
                url = url.slice(this.basePath.length);
            } else {
                return null;
            }
        }

        if (url === '') {
            return '/';
        }
        if (this.trailingSlash === 'ignore' && url.length > 1 && url.endsWith('/')) {
            return url.replace(/\/+$/, '');
        }
        return url;
    }

    /**
     * 单条路由的路径匹配（不含方法判定）
     *
     * @param {RouteEntry} route 路由条目
     * @param {string} url 归一化后的路径
     * @returns {Record<string, string|number|boolean>|null} 命中返回路径参数（按类型转换，无参数为空对象），未命中返回 null
     */
    #matchRoute(route, url) {
        if (route.route === '*') {
            return {};
        }

        if (route.regex === null) {
            return url === route.route ? {} : null;
        }

        const result = route.regex.exec(url);
        if (result === null) {
            return null;
        }

        /** @type {Record<string, string|number|boolean>} */
        const params = {};
        for (const [key, value] of Object.entries(result.groups ?? {})) {
            if (value === undefined) {
                continue;
            }
            params[key] = convertParam(value, route.paramTypes[key] ?? 'string');
        }
        return params;
    }
}

/**
 * 路径参数按类型转换（int / float → number，bool → boolean，其余保留字符串）
 *
 * @param {string} value 原始字符串值
 * @param {string} type 类型名
 * @returns {string|number|boolean} 转换后的值
 */
function convertParam(value, type) {
    switch (type) {
        case 'int':
        case 'float':
            return Number(value);
        case 'bool':
            return value === 'true';
        default:
            return value;
    }
}

/**
 * 归一化注册选项（兼容字符串路由名写法）
 *
 * @param {string|RouteOptions|null} options 路由名或选项对象
 * @returns {{name: string|null, middleware: RouteMiddleware[]}} 归一化选项
 */
function normalizeOptions(options) {
    if (typeof options === 'string') {
        return { name: options, middleware: [] };
    }
    if (options === null || options === undefined) {
        return { name: null, middleware: [] };
    }
    return { name: options.name ?? null, middleware: options.middleware ?? [] };
}

/**
 * 方法判定（HEAD 可命中 GET；`*` 表示任意方法）
 *
 * @param {string[]} methods 路由允许的方法
 * @param {string} method 请求方法（大写）
 * @returns {boolean} 是否匹配
 */
function matchesMethod(methods, method) {
    if (methods.includes('*') || methods.includes(method)) {
        return true;
    }
    return method === 'HEAD' && methods.includes('GET');
}
