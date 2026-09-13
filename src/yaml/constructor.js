/**
 * @fileoverview YAML 构造器（节点图 → JS 值）
 *
 * 节点图来自 composer；本层负责把它变成宿主可直接用的 JS 值，并守住几条安全边界：
 *
 * - **别名共享**：带锚点的节点只构造一次，别名（`*a`）得到**同一个对象引用**，
 *   因此环状结构（`&a [*a]`）能落地，`maxAliasCount` 也不会因为共享而失效；
 * - **原型污染防护**：所有属性写入一律走 `Object.defineProperty`，
 *   文档里的 `__proto__` / `constructor` 键只会成为普通自有属性，不会改写原型；
 * - **重复键**：默认报错（`uniqueKeys: false` 时后值覆盖）；合并键来源不算重复，显式键覆盖合并值；
 * - **合并键**（`<<`，YAML 1.1 遗留语法）：值是映射或映射序列，序列中靠前者优先，
 *   展开的条目数与别名共用 `maxAliasCount` 预算，避免"合并放大"。
 */

import { YamlError } from './yamlError.js';
import { TAG, constructScalarValue } from './schema.js';

/**
 * 标量标签集合（用于"标签与节点种类不匹配"检查）
 * @type {ReadonlySet<string>}
 */
const SCALAR_TAGS = Object.freeze(new Set([
    TAG.NULL,
    TAG.BOOL,
    TAG.INT,
    TAG.FLOAT,
    TAG.STR,
    TAG.BINARY,
    TAG.TIMESTAMP,
    TAG.MERGE,
]));

/**
 * 标签的短名（只含本库的固定常量，不会把文档内容带进消息）
 * @type {Readonly<Record<string, string>>}
 */
const TAG_LABELS = Object.freeze({
    [TAG.NULL]: '!!null',
    [TAG.BOOL]: '!!bool',
    [TAG.INT]: '!!int',
    [TAG.FLOAT]: '!!float',
    [TAG.STR]: '!!str',
    [TAG.BINARY]: '!!binary',
    [TAG.TIMESTAMP]: '!!timestamp',
    [TAG.OMAP]: '!!omap',
    [TAG.PAIRS]: '!!pairs',
    [TAG.SET]: '!!set',
    [TAG.MAP]: '!!map',
    [TAG.SEQ]: '!!seq',
});

/**
 * 构造文档值为 JS 值
 *
 * @param {any} node 节点图根（`null` 表示空文档）
 * @param {Readonly<Record<string, any>>} options 解析选项
 * @returns {any} JS 值
 */
export function constructDocument(node, options) {
    if (node === null || node === undefined) {
        return null;
    }
    const context = {
        options,
        memo: new Map(),
        mergedEntries: 0,
    };
    return constructNode(node, context);
}

/**
 * 构造单个节点
 *
 * @param {any} node 节点
 * @param {any} context 构造上下文
 * @returns {any} JS 值
 */
function constructNode(node, context) {
    switch (node.kind) {
        case 'alias': {
            // 别名只做"解引用"：目标已构造就直接复用，环形结构与重复引用因此天然共享同一对象
            const cached = context.memo.get(node.target);
            if (cached !== undefined) {
                return cached;
            }
            return constructNode(node.target, context);
        }
        case 'scalar':
            return constructScalar(node, context);
        case 'sequence':
            return constructSequence(node, context);
        case 'mapping':
            return constructMapping(node, context);
        default:
            throw new YamlError('construct', '内部错误：未知的节点种类');
    }
}

/**
 * 解开别名链拿到真正的节点
 *
 * @param {any} node 节点
 * @returns {any} 非别名节点
 */
function resolveNodeAlias(node) {
    let current = node;
    while (current !== null && current !== undefined && current.kind === 'alias') {
        current = current.target;
    }
    return current;
}

/**
 * 构造标量
 *
 * @param {any} node 标量节点
 * @param {any} context 构造上下文
 * @returns {any} JS 值
 */
function constructScalar(node, context) {
    if (node.tag === TAG.MERGE) {
        // `<<` 作为普通值出现时按字符串处理（只有作为映射的键才有合并语义）
        return node.value;
    }
    return constructScalarValue(node.value, node.tag, { intAsBigInt: context.options.intAsBigInt });
}

/**
 * 构造序列
 *
 * @param {any} node 序列节点
 * @param {any} context 构造上下文
 * @returns {any} JS 值
 */
function constructSequence(node, context) {
    const cached = context.memo.get(node);
    if (cached !== undefined) {
        return cached;
    }

    if (node.tag === TAG.PAIRS || node.tag === TAG.OMAP) {
        const result = node.tag === TAG.PAIRS ? [] : new Map();
        context.memo.set(node, result);
        for (const item of node.items) {
            const [key, value] = constructPair(item, context);
            if (result instanceof Map) {
                if (result.has(key)) {
                    throw new YamlError('construct', '!!omap 的键必须唯一');
                }
                result.set(key, value);
            } else {
                result.push([key, value]);
            }
        }
        return result;
    }

    if (node.tag === TAG.SET) {
        throw new YamlError('construct', '!!set 只能用于映射');
    }
    if (SCALAR_TAGS.has(node.tag)) {
        throw new YamlError('construct', `${TAG_LABELS[node.tag] ?? '标量标签'} 不能用于序列`);
    }

    const array = [];
    context.memo.set(node, array);
    for (const item of node.items) {
        array.push(constructNode(item, context));
    }
    return array;
}

/**
 * 构造映射
 *
 * @param {any} node 映射节点
 * @param {any} context 构造上下文
 * @returns {any} JS 值
 */
function constructMapping(node, context) {
    const cached = context.memo.get(node);
    if (cached !== undefined) {
        return cached;
    }

    switch (node.tag) {
        case TAG.SET: {
            const set = new Set();
            context.memo.set(node, set);
            for (const entry of node.entries) {
                if (resolveNodeAlias(entry.key).tag === TAG.MERGE) {
                    throw new YamlError('construct', '!!set 里不能使用合并键');
                }
                set.add(constructKey(entry.key, context, true));
            }
            return set;
        }
        case TAG.OMAP: {
            const map = new Map();
            context.memo.set(node, map);
            const seen = new Set();
            for (const entry of node.entries) {
                const key = constructKey(entry.key, context, true);
                if (seen.has(key)) {
                    throw new YamlError('construct', '!!omap 的键必须唯一');
                }
                seen.add(key);
                map.set(key, constructNode(entry.value, context));
            }
            return map;
        }
        case TAG.PAIRS: {
            const pairs = [];
            context.memo.set(node, pairs);
            for (const entry of node.entries) {
                pairs.push([constructKey(entry.key, context, true), constructNode(entry.value, context)]);
            }
            return pairs;
        }
        case TAG.SEQ:
            throw new YamlError('construct', '!!seq 不能用于映射');
        default:
            break;
    }

    if (SCALAR_TAGS.has(node.tag)) {
        throw new YamlError('construct', `${TAG_LABELS[node.tag] ?? '标量标签'} 不能用于映射`);
    }

    const target = context.options.mapAsMap ? new Map() : {};
    context.memo.set(node, target);
    const exactKeys = target instanceof Map;

    /** @type {Array<[any, any]>} */
    const mergedPairs = [];
    /** @type {Array<any>} */
    const explicitEntries = [];

    for (const entry of node.entries) {
        if (context.options.mergeKeys && resolveNodeAlias(entry.key).tag === TAG.MERGE) {
            collectMergedPairs(entry.value, mergedPairs, context);
        } else {
            explicitEntries.push(entry);
        }
    }

    const assigned = new Set();
    for (const [key, value] of mergedPairs) {
        if (assigned.has(key)) {
            continue;
        }
        assigned.add(key);
        assignValue(target, key, value);
    }

    const explicitSeen = new Set();
    for (const entry of explicitEntries) {
        const key = constructKey(entry.key, context, exactKeys);
        if (context.options.uniqueKeys && explicitSeen.has(key)) {
            throw new YamlError('construct', '同一个映射里出现了重复的键');
        }
        explicitSeen.add(key);
        assignValue(target, key, constructNode(entry.value, context));
    }

    return target;
}

/**
 * 收集合并键（`<<`）来源的键值对
 *
 * 值为映射时取其全部条目；值为序列时按"靠前者优先"的语义依次收集。
 *
 * @param {any} valueNode 合并键的值节点
 * @param {Array<[any, any]>} out 收集结果
 * @param {any} context 构造上下文
 * @returns {void}
 */
function collectMergedPairs(valueNode, out, context) {
    const resolved = resolveNodeAlias(valueNode);

    if (resolved.kind === 'sequence') {
        for (const item of resolved.items) {
            const mapping = resolveNodeAlias(item);
            if (mapping.kind !== 'mapping') {
                throw new YamlError('construct', '合并键序列的元素必须是映射');
            }
            pushPairs(mapping, out, context);
        }
        return;
    }

    if (resolved.kind === 'mapping') {
        pushPairs(resolved, out, context);
        return;
    }

    throw new YamlError('construct', '合并键的值必须是映射或映射序列');
}

/**
 * 把某个映射节点的键值对并入合并结果
 *
 * @param {any} mappingNode 映射节点
 * @param {Array<[any, any]>} out 收集结果
 * @param {any} context 构造上下文
 * @returns {void}
 */
function pushPairs(mappingNode, out, context) {
    const value = constructNode(mappingNode, context);
    const entries = value instanceof Map ? value.entries() : Object.entries(value);
    for (const [key, item] of entries) {
        context.mergedEntries += 1;
        if (context.options.maxAliasCount >= 0 && context.mergedEntries > context.options.maxAliasCount) {
            throw new YamlError('construct', `合并键展开的条目数超过 maxAliasCount（${context.options.maxAliasCount}）`);
        }
        out.push([key, item]);
    }
}

/**
 * 构造 `!!pairs` / `!!omap` 的元素对
 *
 * 元素必须是"只有一个键值对的映射"（YAML 1.1 的 `!!omap` 规范形态）。
 *
 * @param {any} itemNode 元素节点
 * @param {any} context 构造上下文
 * @returns {[any, any]} 键值对
 */
function constructPair(itemNode, context) {
    const mapping = resolveNodeAlias(itemNode);
    if (mapping === null || mapping === undefined || mapping.kind !== 'mapping' || mapping.entries.length !== 1) {
        throw new YamlError('construct', '!!pairs / !!omap 的每个元素必须是只含一个键值对的映射');
    }
    const entry = mapping.entries[0];
    return [constructKey(entry.key, context, true), constructNode(entry.value, context)];
}

/**
 * 构造映射的键
 *
 * 普通对象模式下键必须是标量（JS 的属性名只能是字符串），标量值按确定规则转成字符串；
 * `mapAsMap` 模式下保留精确键（集合、null、NaN 等都能当 Map 的键）。
 *
 * @param {any} keyNode 键节点
 * @param {any} context 构造上下文
 * @param {boolean} exact 是否保留精确键（Map / Set / 键值对场景）
 * @returns {any} 键
 */
function constructKey(keyNode, context, exact) {
    const node = resolveNodeAlias(keyNode);
    if (exact) {
        return constructNode(node, context);
    }
    if (node.kind !== 'scalar') {
        throw new YamlError('construct', '普通对象模式不支持非标量键，请改用 mapAsMap: true');
    }
    return keyToString(constructNode(node, context));
}

/**
 * 标量键转字符串（普通对象模式）
 *
 * @param {any} value 标量值
 * @returns {string} 字符串键
 */
function keyToString(value) {
    if (value === null) {
        return 'null';
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (Buffer.isBuffer(value)) {
        return value.toString('base64');
    }
    return String(value);
}

/**
 * 写入一个键值对
 *
 * `Object.defineProperty` 是刻意的：文档里的 `__proto__` 键若用 `target[key] = value` 写入，
 * 会改写对象原型（原型污染），用定义自有属性的方式则只留下一个普通键。
 *
 * @param {any} target 目标（普通对象或 Map）
 * @param {any} key 键
 * @param {any} value 值
 * @returns {void}
 */
function assignValue(target, key, value) {
    if (target instanceof Map) {
        target.set(key, value);
        return;
    }
    Object.defineProperty(target, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
    });
}
