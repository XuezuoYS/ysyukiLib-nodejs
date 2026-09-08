/**
 * 自研薄路由（无第三方依赖）
 *
 * 路由定义：`map(method, route, target, name)`，
 * 占位符 `[i:uid]`、`[a:text]`、`[h:id]`、`[*:path]`、`[**:all]`、`[]` 及可选后缀 `?`。
 *
 * 行为约定：
 * - 编译结果按路由条目缓存；
 * - `match` 未命中返回 `null`，命中返回 `{ target, params, name }`。
 *
 * target 为接收上下文对象的函数 `(ctx) => {...}`，路径参数经 ctx.params 承接。
 *
 */

/**
 * 默认匹配类型（正则片段）
 * @type {Record<string, string>}
 */
const DEFAULT_MATCH_TYPES = {
    i: '[0-9]+',
    a: '[0-9A-Za-z]+',
    h: '[0-9A-Fa-f]+',
    '*': '.+?',
    '**': '.+',
    '': '[^/.]+',
};

/**
 * 占位符块匹配模式（含点/斜杠前缀捕获与可选段后缀）
 */
const BLOCK_PATTERN = /(\/|\.|)\[([^:\]]*)(?::([^:\]]*))?\](\?|)/g;

export class Router {
    /**
     * 全部路由（含命名路由）
     * @type {Array<{method: string, route: string, target: Function, name: string|null, position: number, regex: RegExp|null}>}
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
     * 匹配类型表
     * @type {Record<string, string>}
     */
    matchTypes = { ...DEFAULT_MATCH_TYPES };

    /**
     * @param {Array<[string, string, Function, string?]>} [routes] 批量路由 [[method, route, target, name], ...]
     * @default routes = []
     * @param {string} [basePath] 基础路径
     * @default basePath = ''
     * @param {Record<string, string>} [matchTypes] 追加/覆盖的匹配类型
     * @default matchTypes = {}
     */
    constructor(routes = [], basePath = '', matchTypes = {}) {
        this.addRoutes(routes);
        this.setBasePath(basePath);
        this.addMatchTypes(matchTypes);
    }

    /**
     * 获取全部路由（只读视图）
     * @returns {Array<object>} 全部路由
     */
    getRoutes() {
        return this.routes;
    }

    /**
     * 从数组批量添加路由，格式：[[method, route, target, name], ...]
     *
     * @param {Array<[string, string, Function, string?]>} routes 路由数组
     */
    addRoutes(routes) {
        for (const [method, route, target, name] of routes) {
            this.map(method, route, target, name);
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
     * 将路由映射到目标处理器
     *
     * @param {string} method HTTP 方法，或 `|` 分隔的多方法（GET|POST|PATCH|PUT|DELETE）
     * @param {string} route 路由模式；自定义正则须以 `@` 开头；可用预设匹配类型占位符如 `[i:id]`
     * @param {Function} target 目标处理函数 `(ctx) => {...}`
     * @param {string|null} [name] 路由名称（可用于反向路由 generate）
     * @default name = null
     */
    map(method, route, target, name = null) {
        const position = route.indexOf('[');
        /** @type {RegExp|null} */
        let regex = null;
        if (route.startsWith('@')) {
            regex = new RegExp(route.slice(1), 'u');
        } else if (position !== -1) {
            regex = this.compileRoute(route);
        }

        this.routes.push({ method, route, target, name, position, regex });

        if (name) {
            if (Object.prototype.hasOwnProperty.call(this.namedRoutes, name)) {
                throw new Error(`Can not redeclare route '${name}'`);
            }
            this.namedRoutes[name] = route;
        }
    }

    /**
     * 反向路由：按名称与参数生成 URL
     *
     * @param {string} routeName 路由名称
     * @param {Record<string, any>} [params] 替换占位符的参数
     * @default params = {}
     * @returns {string} 生成的 URL
     */
    generate(routeName, params = {}) {
        if (!Object.prototype.hasOwnProperty.call(this.namedRoutes, routeName)) {
            throw new Error(`Route '${routeName}' does not exist.`);
        }

        const route = this.namedRoutes[routeName];

        // 拼接基础路径
        let url = this.basePath + route;

        let index = 0;
        for (const match of route.matchAll(BLOCK_PATTERN)) {
            const [block, pre, , param = '', optional = ''] = match;
            index += 1;

            let blockBody = block;
            if (pre) {
                blockBody = blockBody.slice(1);
            }

            if (Object.prototype.hasOwnProperty.call(params, param)) {
                // 参数存在，替换为参数值
                url = url.split(blockBody).join(String(params[param]));
            } else if (optional && index !== 1) {
                // 仅当不在基段时剥离前置斜杠/点
                url = url.split(pre + blockBody).join('');
            } else {
                // 剥离匹配块
                url = url.split(blockBody).join('');
            }
        }

        return url;
    }

    /**
     * 匹配请求 URL 与路由表
     *
     * @param {string} requestUrl 请求路径（可含查询串，会剥离）
     * @param {string} requestMethod HTTP 方法
     * @returns {{target: Function, params: Record<string, string>, name: string|null}|null} 命中返回路由信息，未命中返回 null
     */
    match(requestUrl, requestMethod) {
        // 剥离基础路径
        let url = requestUrl.slice(this.basePath.length);

        // 剥离查询串（?a=b）
        const queryIndex = url.indexOf('?');
        if (queryIndex !== -1) {
            url = url.slice(0, queryIndex);
        }

        const lastRequestUrlChar = url.length > 0 ? url[url.length - 1] : '';

        for (const handler of this.routes) {
            const { method: methods, route, target, name, position, regex } = handler;

            const methodMatch = methods.toLowerCase().includes(String(requestMethod).toLowerCase());

            // 方法不匹配，继续下一条路由
            if (!methodMatch) {
                continue;
            }

            /** @type {Record<string, string>} */
            let params = {};
            let isMatch = false;

            /**
             * 从 exec 结果提取命名参数（未参与匹配的可选组不带上）
             * @param {RegExpExecArray} result 匹配结果
             */
            const collectParams = (result) => {
                for (const [key, value] of Object.entries(result.groups ?? {})) {
                    if (value !== undefined) {
                        params[key] = value;
                    }
                }
            };

            if (route === '*') {
                // * 通配（全部匹配）
                isMatch = true;
            } else if (route.startsWith('@')) {
                // @ 自定义正则
                const result = regex ? regex.exec(url) : null;
                if (result) {
                    isMatch = true;
                    collectParams(result);
                }
            } else if (position === -1) {
                // 无参数，直接字符串比较
                isMatch = url === route;
            } else {
                // 先比较最长非参数前缀，再走正则
                // 参数块前一个字符是斜杠时豁免（可选参数可能省略该段）
                if (!url.startsWith(route.slice(0, position)) && (lastRequestUrlChar === '/' || route[position - 1] !== '/')) {
                    continue;
                }

                const result = regex ? regex.exec(url) : null;
                if (result) {
                    isMatch = true;
                    collectParams(result);
                }
            }

            if (isMatch) {
                return { target, params, name };
            }
        }

        return null;
    }

    /**
     * 编译路由的正则（map 时调用一次并缓存）
     *
     * @param {string} route 路由模式
     * @returns {RegExp} 锚定正则
     */
    compileRoute(route) {
        let compiled = route;

        for (const match of route.matchAll(BLOCK_PATTERN)) {
            const [block, pre, type, param = '', optional = ''] = match;

            const typeRegex = Object.prototype.hasOwnProperty.call(this.matchTypes, type)
                ? this.matchTypes[type]
                : type;

            let prefix = pre;
            if (prefix === '.') {
                prefix = '\\.';
            }

            const optionalMark = optional !== '' ? '?' : '';
            const namePart = param !== '' ? `?<${param}>` : '';

            const pattern = `(?:${prefix}(${namePart}${typeRegex})${optionalMark})${optionalMark}`;
            compiled = compiled.split(block).join(pattern);
        }

        return new RegExp('^' + compiled + '$', 'u');
    }
}
