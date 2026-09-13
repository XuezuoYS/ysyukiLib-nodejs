/**
 * @fileoverview YAML 选项默认值与校验
 *
 * 解析与序列化选项在此集中定义、集中校验：非法选项一律抛 `TypeError`（调用方写错了代码，
 * 不是输入数据的问题，故与 `YamlError` 区分），消息里带选项名与期望形状。
 *
 * 返回的选项对象是冻结的新对象，调用方传入的 options 不会被修改。
 */

/**
 * 隐式类型解析表名称
 *
 * - `failsafe`：全部标量为字符串；
 * - `json`：只识别 JSON 能表达的类型（null / bool / number / string）；
 * - `core`：YAML 1.2 core schema（默认）；
 * - `yaml11`：core + YAML 1.1 遗留（yes/no/on/off、0NNN 八进制、时间戳）。
 *
 * @type {ReadonlyArray<string>}
 */
export const SCHEMA_NAMES = Object.freeze(['failsafe', 'json', 'core', 'yaml11']);

/**
 * 未知显式标签的处理策略
 * @type {ReadonlyArray<string>}
 */
export const UNKNOWN_TAG_POLICIES = Object.freeze(['error', 'ignore']);

/**
 * 解析选项默认值
 * @type {Readonly<Record<string, any>>}
 */
export const PARSE_DEFAULTS = Object.freeze({
    schema: 'core',
    uniqueKeys: true,
    mergeKeys: true,
    mapAsMap: false,
    intAsBigInt: false,
    maxAliasCount: 100,
    maxDepth: 256,
    unknownTags: 'error',
    filename: undefined,
});

/**
 * 序列化选项默认值
 * @type {Readonly<Record<string, any>>}
 */
export const STRINGIFY_DEFAULTS = Object.freeze({
    indent: 2,
    lineWidth: 80,
    flowLevel: -1,
    schema: 'core',
    sortKeys: false,
    aliasDuplicateObjects: true,
});

/**
 * 断言取值为布尔
 *
 * @param {string} name 选项名
 * @param {any} value 取值
 * @returns {boolean} 原值
 */
function requireBoolean(name, value) {
    if (typeof value !== 'boolean') {
        throw new TypeError(`YAML 选项 ${name} 必须是布尔值，实际为 ${describe(value)}`);
    }
    return value;
}

/**
 * 断言取值为整数且在闭区间内
 *
 * @param {string} name 选项名
 * @param {any} value 取值
 * @param {number} min 最小值
 * @param {number} max 最大值
 * @returns {number} 原值
 */
function requireInteger(name, value, min, max) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        throw new TypeError(`YAML 选项 ${name} 必须是 ${min}–${max} 之间的整数，实际为 ${describe(value)}`);
    }
    return value;
}

/**
 * 断言取值为枚举内的字符串
 *
 * @param {string} name 选项名
 * @param {any} value 取值
 * @param {ReadonlyArray<string>} allowed 允许值
 * @returns {string} 原值
 */
function requireOneOf(name, value, allowed) {
    if (typeof value !== 'string' || !allowed.includes(value)) {
        throw new TypeError(`YAML 选项 ${name} 必须是 ${allowed.join(' / ')} 之一，实际为 ${describe(value)}`);
    }
    return value;
}

/**
 * 用固定文案描述非法取值
 *
 * 只描述类型或枚举名，不回显任意字符串内容（选项值不是文件内容，但仍避免把长文本抄进消息）。
 *
 * @param {any} value 取值
 * @returns {string} 描述
 */
function describe(value) {
    if (value === null) {
        return 'null';
    }
    if (typeof value === 'string') {
        return value.length <= 24 ? JSON.stringify(value) : `字符串（${value.length} 字符）`;
    }
    return typeof value;
}

/**
 * 校验并冻结解析选项
 *
 * `schemaExplicit` 记录调用方是否显式指定了 schema：未显式指定时，
 * 文档里的 `%YAML 1.1` 指令会把隐式解析表切到 `yaml11`（见 composer.js）。
 *
 * @default options = {}
 * @param {Record<string, any>} [options] 调用方选项
 * @returns {Readonly<Record<string, any>>} 冻结后的完整选项
 */
export function normalizeParseOptions(options = {}) {
    if (options === null || typeof options !== 'object') {
        throw new TypeError(`YAML 解析选项必须是对象，实际为 ${describe(options)}`);
    }

    const schemaExplicit = Object.prototype.hasOwnProperty.call(options, 'schema');
    const schema = options.schema === undefined
        ? PARSE_DEFAULTS.schema
        : requireOneOf('schema', options.schema, SCHEMA_NAMES);

    const filename = options.filename === undefined || options.filename === null
        ? null
        : String(options.filename);

    return Object.freeze({
        schema,
        schemaExplicit,
        uniqueKeys: options.uniqueKeys === undefined
            ? PARSE_DEFAULTS.uniqueKeys
            : requireBoolean('uniqueKeys', options.uniqueKeys),
        mergeKeys: options.mergeKeys === undefined
            ? PARSE_DEFAULTS.mergeKeys
            : requireBoolean('mergeKeys', options.mergeKeys),
        mapAsMap: options.mapAsMap === undefined
            ? PARSE_DEFAULTS.mapAsMap
            : requireBoolean('mapAsMap', options.mapAsMap),
        intAsBigInt: options.intAsBigInt === undefined
            ? PARSE_DEFAULTS.intAsBigInt
            : requireBoolean('intAsBigInt', options.intAsBigInt),
        maxAliasCount: options.maxAliasCount === undefined
            ? PARSE_DEFAULTS.maxAliasCount
            : requireInteger('maxAliasCount', options.maxAliasCount, -1, Number.MAX_SAFE_INTEGER),
        maxDepth: options.maxDepth === undefined
            ? PARSE_DEFAULTS.maxDepth
            : requireInteger('maxDepth', options.maxDepth, 1, 100000),
        unknownTags: options.unknownTags === undefined
            ? PARSE_DEFAULTS.unknownTags
            : requireOneOf('unknownTags', options.unknownTags, UNKNOWN_TAG_POLICIES),
        filename,
    });
}

/**
 * 校验并冻结序列化选项
 *
 * @default options = {}
 * @param {Record<string, any>} [options] 调用方选项
 * @returns {Readonly<Record<string, any>>} 冻结后的完整选项
 */
export function normalizeStringifyOptions(options = {}) {
    if (options === null || typeof options !== 'object') {
        throw new TypeError(`YAML 序列化选项必须是对象，实际为 ${describe(options)}`);
    }

    const sortKeys = options.sortKeys === undefined ? STRINGIFY_DEFAULTS.sortKeys : options.sortKeys;
    if (typeof sortKeys !== 'boolean' && typeof sortKeys !== 'function') {
        throw new TypeError(`YAML 选项 sortKeys 必须是布尔值或比较函数，实际为 ${describe(sortKeys)}`);
    }

    const flowLevel = options.flowLevel === undefined
        ? STRINGIFY_DEFAULTS.flowLevel
        : options.flowLevel;

    if (typeof flowLevel !== 'number' || Number.isNaN(flowLevel) || flowLevel < -1) {
        throw new TypeError(`YAML 选项 flowLevel 必须是不小于 -1 的数字，实际为 ${describe(flowLevel)}`);
    }

    const lineWidth = options.lineWidth === undefined
        ? STRINGIFY_DEFAULTS.lineWidth
        : requireInteger('lineWidth', options.lineWidth, 0, 100000);

    return Object.freeze({
        indent: options.indent === undefined
            ? STRINGIFY_DEFAULTS.indent
            : requireInteger('indent', options.indent, 1, 9),
        lineWidth,
        flowLevel,
        schema: options.schema === undefined
            ? STRINGIFY_DEFAULTS.schema
            : requireOneOf('schema', options.schema, SCHEMA_NAMES),
        sortKeys,
        aliasDuplicateObjects: options.aliasDuplicateObjects === undefined
            ? STRINGIFY_DEFAULTS.aliasDuplicateObjects
            : requireBoolean('aliasDuplicateObjects', options.aliasDuplicateObjects),
    });
}
