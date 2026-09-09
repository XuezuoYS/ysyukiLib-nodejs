import { Logger } from '../logger.js';

/**
 * @fileoverview 自研薄路由（FastAPI 风格模板，无第三方依赖）
 *
 * 模板语法（路径段占位符）：
 * - `{name}`：默认字符串段（不含斜杠）；
 * - `{name:type}`：指定类型段，内置 int / float / bool / string / hex / alpha / path / all；
 * - 参数名须是标识符（字母、数字、下划线或 `$`，不以数字开头）、同一条模板内唯一，
 *   且不能是 `__proto__`（该键无法写入 params）；`{}` 是**匿名段**（参与匹配、不进 params），
 *   而 `{int}` 不是匿名段——它是名为 `int` 的 string 段，指类型必须带冒号（`{n:int}`）；
 * - `{name:type?}` 或 `{name?}`：可选段（缺失时该键不出现在 params）；
 * - `{path:path}`：跨斜杠捕获（非贪婪，至少一个字符）；`{rest:all}`：跨斜杠且包含尾斜杠；
 * - 块外的其余部分（含 `group()` 前缀）是**路径字面量**：正则元字符编译时自动转义，
 *   不参与匹配语义——`.` 不再充当通配符，故 `/a.b/{id:int}` 不会命中 `/axb/7`；
 * - `@` 前缀：整条路由按自定义正则匹配（命名组进 params，数字组丢弃；缺锚定时自动补 `^...$`）；
 * - `*`：整条路由恰为 `*` 时通配全部路径（模板里的 `*` 是字面量）。
 *
 * 行为约定：
 * - 匹配按注册顺序，先注册先命中；
 * - `match` 返回 `{ status, target, params, name, allowed, badParam, middleware }`：
 *   status 为 hit / methodNotAllowed / badParam / notFound；路径命中而方法不符时给出 allowed（405 用）；
 * - `int` / `float` 段**仅在结果能精确表示该十进制文本时**才转成 number，否则返回
 *   `status: 'badParam'`（`HttpServer` 出口为 400）：否则 `/user/…99` 与 `/user/…98` 会同时得到
 *   `1e20`、310 位数字得到 `Infinity`，不同 URL 落成同一参数值，构成鉴权/查库的混淆面。
 *   不改变数值的收敛（`007 → 7`、`1.0 → 1`）仍按 number 转换；要原始文本就用 `{id}` / `{id:string}`。
 *   badParam 不抢命中：整表扫完后按 hit > methodNotAllowed > badParam > notFound 定夺；
 * - 方法声明在注册期校验：`|` 分隔、每段只含 `A-Z` `0-9` `-`（声明先统一大写，故大小写不敏感），
 *   `*` 必须独占并展开为 `HTTP_METHODS`（标准方法集合）。因此 `any()` 不再接受
 *   `PROPFIND` / `MERGE` / `SUBSCRIBE` 这类非标准动词而是给出 405 + 具体 `Allow`，
 *   自定义动词请显式 `map('PROPFIND', ...)`；解析器不认的动词（如 `BLOB`）在 Node 的
 *   HTTP 解析层就已被判 400，根本进不到路由；
 * - HEAD 请求可命中 GET 路由（响应体由入口层按 HEAD 语义抑制）；
 * - 默认忽略尾斜杠（`trailingSlash: 'strict'` 可关闭）；
 * - `generate` 默认对参数值做 URL 编码（`{path:path}` / `{rest:all}` 按段编码、保留斜杠），
 *   可用 `generate(name, params, { encode: false })` 关闭；`@` 自定义正则路由不支持反向生成；
 * - 手工拼 URL 时用 `encodeUrlParam(value, { keepSlash })`，与 `generate` 同一套编码规则；
 * - 注册期语法护栏（一律中文消息、启动阶段即暴露，不留到运行期）：未知类型、空/非法类型片段、
 *   非法或重复的参数名、无法解析的占位符（如 `{v:}` 少写类型名）、空/非法方法声明；
 *   `@` 模式与模板的正则编译失败也统一包装（原始异常保留在 `cause`）。
 *   自定义类型用 `addMatchTypes` 追加。含配对花括号却没解析成占位符的片段按拼写错误抛错；
 *   只含 `{` 而无配对 `}` 的（如 `/a{b/x`）仍按路径字面量处理；
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
 */

/**
 * @typedef {(ctx: any, next: () => Promise<void>) => any} RouteMiddleware 路由中间件函数
 * @typedef {{name?: string|null, middleware?: RouteMiddleware[]}} RouteOptions 单条路由的注册选项
 * @typedef {object} RouteEntry 已注册路由条目
 * @property {string[]} methods 允许的方法（`*` / `any()` 已在注册期展开为 `HTTP_METHODS`，故永不含 `*`）
 * @property {string} route 注册时的路由模式
 * @property {Function} target 处理器
 * @property {string|null} name 路由名
 * @property {RegExp|null} regex 编译后的正则（无占位符时为 null）
 * @property {Record<string, string>} paramTypes 各路径参数的类型
 * @property {RouteMiddleware[]} middleware 该路由绑定的中间件
 * @typedef {{name: string, type: string}} BadParam 命中但超出类型可精确表示范围的路径参数
 * @typedef {{status: 'hit'|'methodNotAllowed'|'badParam'|'notFound', target: Function|null, params: Record<string, string|number|boolean>, name: string|null, allowed: string[], badParam: BadParam|null, middleware: RouteMiddleware[]}} RouteMatch `match` 的匹配结果（status 四态；allowed 供 405 用）
 * @typedef {{params: Record<string, string|number|boolean>, badParam: BadParam|null}} SegmentMatch 单条路由的路径匹配结果
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

/**
 * 标准 HTTP 方法集合（RFC 9110 §9 + PATCH）
 *
 * `*`（即 `any()`）在注册期展开成这份列表，而不是"接受任意方法"：通配方法的路由
 * 会让非标准动词（`BLOB`、拼错的 `DELEET`）也静默进入处理器，且 405 对其永不触发。
 * 自定义 / WebDAV 动词请显式注册（`map('PROPFIND', ...)`）。
 *
 * @type {readonly string[]}
 */
export const HTTP_METHODS = Object.freeze([
    'GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT',
]);

/** 合法方法 token（声明已统一大写后再校验）：大写字母开头，允许数字与连字符 */
const METHOD_TOKEN_PATTERN = /^[A-Z][A-Z0-9-]*$/;

/** 合法参数名：JS 命名捕获组的 ASCII 子集（`(?<name>)` 只接受标识符） */
const BLOCK_NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * 合法类型名：模板里可被引用的形态（BLOCK_PATTERN 的类型段是 `[^}?]+`，
 * 含空格 / `:` / `?` / `}` 的类型名注册进来也无法在模板中写到）
 */
const TYPE_NAME_PATTERN = /^[^:?\s}]+$/;

/** 占位符类型段缺失的形态：`{v:}` / `{v: }`（少写类型名，不能静默降级成字面量路由） */
const MISSING_TYPE_PATTERN = /^\{([^}:?]*)\s*:\s*\}$/;

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
 * 编译正则并把语法错误包成可读的中文消息
 *
 * 原始 `SyntaxError` 是英文且带正则源里的字节位置（如 `Invalid capture group name`），
 * 直接冒出来既看不懂是哪条路由、也看不出该怎么改，故统一包装并保留 `cause` 供排障。
 *
 * @param {string} source 正则源
 * @param {string} flags 正则标志
 * @param {string} origin 出错描述（含路由原文）
 * @returns {RegExp} 编译结果
 * @throws {Error} 包装后的中文错误（`cause` 为原始异常）
 */
function compileRegExp(source, flags, origin) {
    try {
        return new RegExp(source, flags);
    } catch (err) {
        throw new Error(`${origin}\n  原因：${err instanceof Error ? err.message : String(err)}`, {
            cause: err,
        });
    }
}

/**
 * 方法声明归一化（大写、`|` 分隔、去重；`*` 展开为标准方法集合）
 *
 * 三处静默陷阱必须拦下：空声明（`''` / `'|'`）注册出来是永不命中的死路由；
 * `GET POST`、`GET,POST` 这类分隔符写错会被当成一个"方法名"，既不命中又会在 405 里
 * 输出 `Allow: GET POST` 并吞掉本应返回的 404；`GET|*` 里的 `*` 会让前半段形同虚设。
 *
 * @param {string} spec 方法声明（`GET`、`GET|POST`、`*`）
 * @returns {string[]} 去重后的方法列表（按出现顺序，永不含 `*`）
 * @throws {Error} 声明为空、含非法 token，或 `*` 与其他方法并列
 */
function parseMethods(spec) {
    const raw = String(spec).toUpperCase();
    const items = [...new Set(raw.split('|').map((item) => item.trim()).filter((item) => item !== ''))];

    if (items.length === 0) {
        throw new Error(
            `路由方法声明为空："${spec}"；至少需要一个方法（GET 或 GET|POST），或用 * 表示标准方法集合`,
        );
    }
    if (items.includes('*')) {
        if (items.length > 1) {
            throw new Error(`路由方法声明的 * 表示全部标准方法，不能与其他方法并列："${spec}"`);
        }
        return [...HTTP_METHODS];
    }
    for (const item of items) {
        if (!METHOD_TOKEN_PATTERN.test(item)) {
            throw new Error(
                `路由方法名不合法："${item}"（声明："${spec}"）；方法以 | 分隔，每段须为大写字母开头的 A-Z0-9- 序列`,
            );
        }
    }
    return items;
}

/**
 * 校验单个占位块的参数名
 *
 * 命名捕获组只接受标识符：`{a-b:int}` 会在 `new RegExp` 处抛英文 `SyntaxError`
 * （启动即崩、看不出是哪条路由），`{id:int}/{id:int}` 则是重复组名。
 * 参数名还要避开 `__proto__`——它能编译通过，但写不进 params（原型 setter 吞掉）。
 *
 * @param {string} name 占位块名字（匿名为空串）
 * @param {string} type 占位块类型名
 * @param {string} route 路由原文（错误消息用）
 * @param {Set<string>} seenNames 本条模板内已出现过的参数名（调用方提供，逐块累积）
 * @throws {Error} 名字非法、为 `__proto__`，或本条模板内重复
 */
function assertBlockName(name, type, route, seenNames) {
    if (name === '') {
        return;
    }
    if (!BLOCK_NAME_PATTERN.test(name)) {
        throw new Error(
            `路由参数名不合法："${name}"（路由 ${route}）；须为字母、数字、下划线或 $，且不能以数字开头（类型 ${type}）`,
        );
    }
    if (name === '__proto__') {
        throw new Error(`路由参数名不能为 __proto__（路由 ${route}）：该键无法写入 params`);
    }
    if (seenNames.has(name)) {
        throw new Error(`路由参数名重复："${name}"（路由 ${route}）；同一模板内每个参数名必须唯一`);
    }
    seenNames.add(name);
}

/**
 * 检测"含配对花括号却没解析成占位块"的片段
 *
 * `{v:}`（少写类型名）不匹配 BLOCK_PATTERN，历史上会被整段当字面量编成 `^\/x\/\{v:\}$`
 * 的路由：注册期零告警，运行期永远 404，是最难发现的一类拼写错误。
 * 只含 `{` 而无配对 `}` 的（`/a{b/x`）继续按字面量处理，不在本检查范围内。
 *
 * @param {string} route 路由原文
 * @param {Array<{start: number, end: number}>} blocks 已成功解析的占位块区间（原串位置）
 * @throws {Error} 存在未解析的花括号片段
 */
function assertBlocksParsed(route, blocks) {
    /** 已解析块的右边界：扫描到 `{` 时，只要落在任一区间内就跳过 */
    let coveredUntil = -1;
    let blockIdx = 0;

    for (let i = 0; i < route.length; i += 1) {
        if (route[i] !== '{') {
            continue;
        }
        while (blockIdx < blocks.length && blocks[blockIdx].start <= i) {
            coveredUntil = blocks[blockIdx].end;
            blockIdx += 1;
        }
        if (i < coveredUntil) {
            continue;
        }
        const close = route.indexOf('}', i + 1);
        const nextOpen = route.indexOf('{', i + 1);
        if (close === -1 || (nextOpen !== -1 && nextOpen < close)) {
            // 无配对右花括号（或右括号属于后一个块）：按字面量处理，维持既有行为
            continue;
        }
        const span = route.slice(i, close + 1);
        const missingType = MISSING_TYPE_PATTERN.exec(span);
        if (missingType !== null) {
            throw new Error(
                `路由占位符 "${span}" 缺少类型名（路由 ${route}）；写 {${missingType[1]}}（默认 string）或 {${missingType[1]}:int}`,
            );
        }
        throw new Error(
            `路由占位符语法错误："${span}"（路由 ${route}）；合法形式为 {name}、{name:type}、{name?}、{name:type?}`,
        );
    }
}

/**
 * URL 参数编码（反向路由与手工拼 URL 共用）
 *
 * 把变量安全地拼进 URL：编码后 `#` / `?` / `/` / 空格等结构字符变成 `%XX`，
 * 不会再被解析成 URL 结构（`#` 之后的内容原本根本不会发给服务器）。
 * 默认整段编码；`keepSlash: true` 保留 `/` 作为分隔符（跨斜杠类型 `{path:path}` / `{rest:all}` 用）。
 *
 * @default options = {}
 * @param {any} value 原始值（非字符串经 String() 转换）
 * @param {object} [options] 选项
 * @param {boolean} [options.keepSlash] 是否保留斜杠作为路径分隔符
 * @returns {string} 已编码的 URL 片段
 */
export function encodeUrlParam(value, options = {}) {
    const text = String(value);
    return options.keepSlash === true
        ? text.split('/').map((segment) => encodeURIComponent(segment)).join('/')
        : encodeURIComponent(text);
}

/** 块外字面量里需要转义的正则元字符（含转义符自身；`/` 在 RegExp 源里无需转义） */
const REGEX_METACHAR_PATTERN = /[.*+?^${}()|[\]\\]/g;

/**
 * 转义路由模板里**块外**的字面量段
 *
 * 编译出的正则源里只有占位块是正则，其余都是路径字面量。不转义时 `.` 会变成通配符
 * （实测 `/a.b/{id:int}` 命中 `/axb/7`），`(` `)` `{` 等在 `u` 标志下还会直接抛语法错误。
 *
 * @param {string} text 字面量文本
 * @returns {string} 可安全嵌入正则源的文本
 */
function escapeRegexLiteral(text) {
    return text.replace(REGEX_METACHAR_PATTERN, '\\$&');
}

/**
 * 按原串位置一次性应用替换（不改动未被替换的字面量段）
 *
 * @param {string} source 原串
 * @param {{start: number, end: number, text: string}[]} edits 替换项（按任意顺序，互不重叠）
 * @param {(text: string) => string} [escapeLiteral] 字面量段转换器；编译路由正则时用于转义元字符，
 *   反向生成 URL 时不传（URL 里就该是原样字面量）
 * @returns {string} 替换结果
 */
function applyEdits(source, edits, escapeLiteral) {
    const plain = (/** @type {string} */ text) =>
        escapeLiteral === undefined ? text : escapeLiteral(text);
    const sorted = [...edits].sort((a, b) => a.start - b.start);
    let result = '';
    let cursor = 0;
    for (const edit of sorted) {
        result += plain(source.slice(cursor, edit.start)) + edit.text;
        cursor = edit.end;
    }
    return result + plain(source.slice(cursor));
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

/**
 * 路由表（注册、匹配与反向生成）
 *
 * 契约摘要：匹配按注册顺序、先注册先命中；`match` 返回 `status` 为
 * hit / methodNotAllowed / badParam / notFound 的匹配结果；路径命中而方法不符时给出 `allowed`（405 用）；
 * `int` / `float` 段仅在结果能精确表示该十进制文本时才转 number，否则判为 badParam。
 *
 * 完整约定（模板语法、注册期语法与正则护栏、安全红线、中间件绑定）见本文件顶部 `@fileoverview` 与 docs/httpServer.md。
 *
 * 常用入口：get / post / put / patch / delete / map / any / use / group / match / generate / addMatchTypes
 */
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
     * @default options = {}
     * @param {object} [options] 选项
     * @param {Array<[string, string, Function, (string|RouteOptions)?]>} [options.routes] 批量路由
     * @param {string} [options.basePath] 基础路径
     * @param {'ignore'|'strict'} [options.trailingSlash] 尾斜杠策略
     * @param {Record<string, string>} [options.types] 追加/覆盖的匹配类型
     */
    constructor(options = {}) {
        const { routes = [], basePath = '', trailingSlash = 'ignore', types = {} } = options;
        // 类型表必须先于 routes 就位：routes 里的 {v:custom} 允许引用同批传入的 types
        this.addMatchTypes(types);
        this.setBasePath(basePath);
        this.trailingSlash = trailingSlash;
        this.addRoutes(routes);
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
     * 类型名与片段在注册期即校验：含空格/`:`/`?`/`}` 的名字在模板里根本写不出来，
     * 空片段会编译成匹配空串的 `(?<v>)`，两者都是静默失效的陷阱。
     *
     * @param {Record<string, string>} matchTypes 类型表，键为名称，值为正则片段
     * @throws {Error} 类型名不合法，或正则片段为空
     */
    addMatchTypes(matchTypes) {
        if (matchTypes === null || matchTypes === undefined) {
            return;
        }
        for (const [name, pattern] of Object.entries(matchTypes)) {
            if (!TYPE_NAME_PATTERN.test(name)) {
                throw new Error(
                    `路由匹配类型名不合法："${name}"；类型名不能含空格、冒号、问号或花括号（模板里无法引用）`,
                );
            }
            if (typeof pattern !== 'string' || pattern === '') {
                throw new Error(
                    `路由匹配类型 "${name}" 的正则片段为空：空片段会匹配空串，请给出具体模式`,
                );
            }
        }
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
     * @default options = null
     * @param {string} method HTTP 方法，或 `|` 分隔的多方法（GET|POST），`*` 展开为 `HTTP_METHODS`
     * @param {string} route 路由模式
     * @param {Function} target 处理器 `(ctx) => any`
     * @param {string|RouteOptions|null} [options] 路由名（字符串）或选项对象 `{ name, middleware }`
     * @throws {Error} 方法声明为空/非法，或 `*` 与其他方法并列
     */
    map(method, route, target, options = null) {
        const { name, middleware } = normalizeOptions(options);
        // 方法声明先校验：与模板无关，报错成本最低且归因更直接
        const methods = parseMethods(method);
        const prefix = this.#groupStack.map((item) => item.prefix).join('');
        const groupMiddleware = this.#groupStack.flatMap((item) => [...item.middleware]);

        const fullRoute = prefix + route;
        const { regex, paramTypes } = this.compileRoute(fullRoute);

        this.routes.push({
            methods,
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
     * @default options = null
     * @param {string} route 路由模式
     * @param {Function} target 处理器
     * @param {string|RouteOptions|null} [options] 路由名或选项
     */
    get(route, target, options = null) {
        this.map('GET', route, target, options);
    }

    /**
     * 注册 POST 路由
     *
     * @default options = null
     * @param {string} route 路由模式
     * @param {Function} target 处理器
     * @param {string|RouteOptions|null} [options] 路由名或选项
     */
    post(route, target, options = null) {
        this.map('POST', route, target, options);
    }

    /**
     * 注册 PUT 路由
     *
     * @default options = null
     * @param {string} route 路由模式
     * @param {Function} target 处理器
     * @param {string|RouteOptions|null} [options] 路由名或选项
     */
    put(route, target, options = null) {
        this.map('PUT', route, target, options);
    }

    /**
     * 注册 PATCH 路由
     *
     * @default options = null
     * @param {string} route 路由模式
     * @param {Function} target 处理器
     * @param {string|RouteOptions|null} [options] 路由名或选项
     */
    patch(route, target, options = null) {
        this.map('PATCH', route, target, options);
    }

    /**
     * 注册 DELETE 路由
     *
     * @default options = null
     * @param {string} route 路由模式
     * @param {Function} target 处理器
     * @param {string|RouteOptions|null} [options] 路由名或选项
     */
    delete(route, target, options = null) {
        this.map('DELETE', route, target, options);
    }

    /**
     * 注册任意**标准**方法的路由（`HTTP_METHODS`：GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS/TRACE/CONNECT）
     *
     * 非标准动词不会命中本路由而是得到 405；需要放行自定义动词（WebDAV 的 `PROPFIND` 等）
     * 请显式 `map('PROPFIND', route, target, options)`。
     *
     * @default options = null
     * @param {string} route 路由模式
     * @param {Function} target 处理器
     * @param {string|RouteOptions|null} [options] 路由名或选项
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
     * @default params = {}, options = {}
     * @param {string} routeName 路由名称
     * @param {Record<string, any>} [params] 替换占位符的参数
     * @param {object} [options] 选项
     * @param {boolean} [options.encode] 是否编码参数值，默认 true
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
     * 定夺优先级：hit > methodNotAllowed > badParam > notFound。
     * 路径命中但 `int` / `float` 参数超出可精确表示范围时记下首个 badParam 并**继续扫描**
     * （后面的 `string` 段路由或 `*` 兜底路由仍可正常命中）。
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
        /** @type {BadParam|null} */
        let badParam = null;

        // basePath 不匹配（null）时直接 404：连 `*` 通配路由也不参与
        if (url !== null) {
            for (const route of this.routes) {
                const matched = this.#matchRoute(route, url);
                if (matched === null) {
                    continue;
                }
                const methodOk = matchesMethod(route.methods, method);

                // 路径形状命中但本轮不能派发：参数值越界（记下首个成因）或方法不符。
                // 越界不阻断后续路由的命中（继续扫描）；方法确实不符时才照常贡献 allowed。
                if (matched.badParam !== null || !methodOk) {
                    if (matched.badParam !== null && badParam === null) {
                        badParam = matched.badParam;
                    }
                    if (!methodOk) {
                        for (const item of route.methods) {
                            allowed.add(item);
                        }
                    }
                    continue;
                }

                return {
                    status: 'hit',
                    target: route.target,
                    params: matched.params,
                    name: route.name,
                    allowed: [],
                    badParam: null,
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
                badParam: null,
                middleware: [],
            };
        }
        if (badParam !== null) {
            return {
                status: 'badParam',
                target: null,
                params: {},
                name: null,
                allowed: [],
                badParam,
                middleware: [],
            };
        }
        return {
            status: 'notFound',
            target: null,
            params: {},
            name: null,
            allowed: [],
            badParam: null,
            middleware: [],
        };
    }

    /**
     * 编译路由的正则（map 时调用一次并缓存）
     *
     * 无占位符且非 `@` 自定义正则时返回 regex: null（走字符串比较）；
     * `@` 模式缺锚定时自动补 `^...$`，并对模式与自定义类型片段做注册期护栏；
     * 模板模式下块外字面量段经 `escapeRegexLiteral` 转义，只有占位块参与正则语义；
     * 占位符本身在编译前先过语法/参数名校验，正则编译失败统一包成中文错误
     * （原始异常留在 `cause`），不让英文 `SyntaxError` 裸抛到启动日志里。
     *
     * @param {string} route 路由模式
     * @returns {{regex: RegExp|null, paramTypes: Record<string, string>}} 锚定正则与参数类型表
     * @throws {Error} 占位符语法错误、参数名非法/重复、未知类型、正则过长或编译失败
     */
    compileRoute(route) {
        if (route.startsWith('@')) {
            const source = route.slice(1);
            guardPattern(source, `@${source}`);
            return { regex: compileRegExp(anchorPattern(source), 'u', `@ 自定义正则编译失败：@${source}`), paramTypes: {} };
        }

        if (route === '*' || route.indexOf('{') === -1) {
            return { regex: null, paramTypes: {} };
        }

        // 与 generate 同策略：按原串位置一次性替换，避免"替换结果里含块文本"被二次替换；
        // 差别在于这里块外的字面量段要转义成正则字面量（generate 输出的是 URL，原样即可）
        /** @type {{start: number, end: number, text: string}[]} */
        const edits = [];
        /** @type {Record<string, string>} */
        const paramTypes = {};
        /** @type {Set<string>} 本条模板内已出现的参数名（重复即命名捕获组冲突） */
        const seenNames = new Set();

        for (const match of route.matchAll(BLOCK_PATTERN)) {
            const [block, prefix, name, type = 'string', optional] = match;
            const start = match.index;

            assertBlockName(name, type, route, seenNames);

            if (!Object.prototype.hasOwnProperty.call(this.matchTypes, type)) {
                throw new Error(`未知的路由类型："${type}"（路由 ${route}，可用 addMatchTypes 追加）`);
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

        assertBlocksParsed(route, edits);

        return {
            // 块外字面量段转义：只有占位块是正则，其余按纯文本匹配
            regex: compileRegExp(`^${applyEdits(route, edits, escapeRegexLiteral)}$`, 'u', `路由模板编译失败：${route}`),
            paramTypes,
        };
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
     * @returns {SegmentMatch|null} 未命中路径返回 null；命中返回 params（按类型转换，无参数为空对象）；
     *   命中但 `int` / `float` 值超出可精确表示范围返回 `{ params: {}, badParam }`
     */
    #matchRoute(route, url) {
        if (route.route === '*') {
            return { params: {}, badParam: null };
        }

        if (route.regex === null) {
            return url === route.route ? { params: {}, badParam: null } : null;
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
            // paramTypes 是普通对象：直接取键会把 '__proto__' 读成 Object.prototype
            const type = Object.prototype.hasOwnProperty.call(route.paramTypes, key)
                ? route.paramTypes[key]
                : 'string';
            const converted = convertParam(value, type);
            if (converted === PARAM_OUT_OF_RANGE) {
                return { params: {}, badParam: { name: key, type } };
            }
            // defineProperty 而非赋值：`@` 正则里的 (?<__proto__>…) 命名组走赋值会被
            // 原型 setter 吞掉（整段值静默丢失），这里要的是 params 上的自有键
            Object.defineProperty(params, key, {
                value: converted,
                enumerable: true,
                writable: true,
                configurable: true,
            });
        }
        return { params, badParam: null };
    }
}

/** `int` / `float` 转换失败的哨兵：值命中类型语法，但结果无法精确表示该十进制文本 */
const PARAM_OUT_OF_RANGE = Symbol('paramOutOfRange');

/**
 * 十进制文本 → 归一形态 `{ digits, scale }`，满足 `value = digits × 10^(-scale)`
 *
 * 去掉前导零与末尾零，使 `007` 与 `7`、`1.0` 与 `1` 归一到同一形态（这类收敛不改变数值，
 * 是保留行为）；同时支持 `Number#toString()` 可能给出的 e 记法（`1e+20`、`1.5e-7`）。
 * 用字符串归一而不是数值比较：要判定的不是"两个 double 是否相等"，
 * 而是"文本与解析结果是否表示同一个十进制数"。
 *
 * @param {string} text 十进制文本（可带符号与 e 记法）
 * @returns {{digits: string, scale: number}|null} 归一形态；非十进制（`Infinity` / `NaN`）返回 null
 */
function decimalForm(text) {
    const eIndex = text.search(/[eE]/);
    const mantissa = eIndex === -1 ? text : text.slice(0, eIndex);
    const exponent = eIndex === -1 ? 0 : Number(text.slice(eIndex + 1));
    if (!Number.isInteger(exponent)) {
        return null;
    }

    const unsigned = /^[+-]/.test(mantissa) ? mantissa.slice(1) : mantissa;
    const dotIndex = unsigned.indexOf('.');
    const intPart = dotIndex === -1 ? unsigned : unsigned.slice(0, dotIndex);
    const fracPart = dotIndex === -1 ? '' : unsigned.slice(dotIndex + 1);
    if (!/^[0-9]*$/.test(intPart) || !/^[0-9]*$/.test(fracPart)) {
        return null;
    }

    let digits = intPart + fracPart;
    let scale = fracPart.length - exponent;
    digits = digits.replace(/^0+/, '');
    if (digits === '') {
        return { digits: '0', scale: 0 };
    }
    while (digits.endsWith('0')) {
        digits = digits.slice(0, -1);
        scale -= 1;
    }
    return { digits, scale };
}

/**
 * 该十进制文本能否被 `Number` 结果精确表示（`int` / `float` 是否可安全转换）
 *
 * 两侧各归一后比较，于是同时挡住三类破坏"URL → params 单射"的塌缩：
 * 超出精度的大数（`…99` 与 `…98` 同为 `1e20`）、溢出成 `Infinity` 的超长数字，
 * 以及小数位过长被截断（`1.23456789012345678901` → `1.2345678901234568`）；
 * 而 `007 → 7`、`1.0 → 1` 这类不改变数值的收敛仍然放行。
 * 判定标准是"无损"，不是"安全整数"：`9007199254740992`（2^53）文本精确故放行，
 * `9007199254740993` 被舍入故拒绝。
 *
 * @param {string} text 十进制文本
 * @returns {boolean} 精确可表示
 */
function isExactDecimal(text) {
    const num = Number(text);
    if (!Number.isFinite(num)) {
        return false;
    }
    const fromText = decimalForm(text);
    const fromNumber = decimalForm(String(num));
    return fromText !== null && fromNumber !== null
        && fromText.digits === fromNumber.digits && fromText.scale === fromNumber.scale;
}

/**
 * 路径参数按类型转换（int / float → number，bool → boolean，其余保留字符串）
 *
 * `int` / `float` 只在 `isExactDecimal` 通过时才转 number，否则返回
 * {@link PARAM_OUT_OF_RANGE}，由匹配层转成 `status: 'badParam'`（`HttpServer` 出口 400）：
 * 不同 URL 落成同一参数值是鉴权/查库的混淆面，宁可直接拒绝也不能塌缩。
 *
 * @param {string} value 原始字符串值
 * @param {string} type 类型名
 * @returns {string|number|boolean|symbol} 转换后的值，或越界哨兵
 */
function convertParam(value, type) {
    switch (type) {
        case 'int':
        case 'float':
            return isExactDecimal(value) ? Number(value) : PARAM_OUT_OF_RANGE;
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
 * 方法判定（HEAD 可命中 GET）
 *
 * `methods` 由 {@link parseMethods} 产出，`*` 已在注册期展开为标准方法集合，
 * 因此这里不再有"任意方法"分支：非标准动词落到 405，`Allow` 头也总是具体方法。
 *
 * @param {string[]} methods 路由允许的方法
 * @param {string} method 请求方法（大写）
 * @returns {boolean} 是否匹配
 */
function matchesMethod(methods, method) {
    if (methods.includes(method)) {
        return true;
    }
    return method === 'HEAD' && methods.includes('GET');
}
