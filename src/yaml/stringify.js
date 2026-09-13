/**
 * @fileoverview YAML 序列化（JS 值 → YAML 文本）
 *
 * 输出目标：**能被本库 parse 回等价值**。为此：
 * - 标量样式按"必要才加引号"选择：plain → 单引号 → 双引号 → 块字面量；
 *   判定"照原样写会不会被解析成别的类型"直接复用 schema.js 的 `wouldResolveAsNonString`，
 *   保证写与读用的是同一张真值表；
 * - 环状结构与重复引用的对象用锚点 / 别名表达（`&ref1` / `*ref1`），环状结构**必须**用锚点；
 * - `Map` → `!!omap`（保留精确键与顺序）、`Set` → `!!set`、`Buffer` / `Uint8Array` → `!!binary`、
 *   `Date` → `!!timestamp`；`undefined` / 函数 / `symbol` 一律写成 `null`；
 * - 行宽折行只发生在"折了也不会改变语义"的位置（流式集合换行、双引号标量的 `\` 续行、
 *   plain / 单引号标量在空格处折行），并由 round-trip 用例兜住。
 */

import { YamlError } from './yamlError.js';
import { normalizeStringifyOptions } from './options.js';
import { wouldResolveAsNonString } from './schema.js';

/**
 * 一个值的格式化结果
 *
 * 二选一：
 * - 只有 `inline`：单行值，接在 `key: ` / `- ` 之后，或单独成行；
 * - 有 `head` / `body`：多行值，`head`（标签 / 锚点，可为空串）接在 `key: ` 之后，
 *   `body` 是已带缩进的正文行（自身不含结尾换行）。
 *
 * @typedef {object} FormattedNode
 * @property {string} [inline] 单行文本
 * @property {string} [head] 多行值的首行头部
 * @property {string} [body] 多行值的正文
 */

/**
 * 序列化单个值
 *
 * @default options = {}
 * @param {any} value JS 值
 * @param {Record<string, any>} [options] 序列化选项（见 options.js）
 * @returns {string} YAML 文本（恒以 `\n` 结尾）
 */
export function stringifyDocument(value, options = {}) {
    return new Stringifier(normalizeStringifyOptions(options)).stringify(value);
}

/**
 * 序列化为多文档文本
 *
 * 每个文档都以 `---` 开头（与 `Yaml.parseAll` 对称）；每个文档都新建一个序列化器，
 * 锚点编号不跨文档复用。
 *
 * @default options = {}
 * @param {Array<any>} values 值数组
 * @param {Record<string, any>} [options] 序列化选项
 * @returns {string} YAML 多文档文本
 */
export function stringifyDocuments(values, options = {}) {
    if (!Array.isArray(values)) {
        throw new TypeError('YAML 多文档序列化需要数组');
    }
    const normalized = normalizeStringifyOptions(options);
    return values.map((value) => `---\n${new Stringifier(normalized).stringify(value)}`).join('');
}

/**
 * 是否"按集合处理"的对象
 *
 * @param {any} value 值
 * @returns {boolean} 是集合返回 true
 */
function isCollection(value) {
    if (value === null || typeof value !== 'object') {
        return false;
    }
    if (Array.isArray(value) || value instanceof Map || value instanceof Set) {
        return true;
    }
    if (value instanceof Date || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
        return false;
    }
    return true;
}

/**
 * 取集合的子值（用于锚点分析）
 *
 * @param {any} value 集合
 * @returns {Array<any>} 子值
 */
function childrenOf(value) {
    if (Array.isArray(value)) {
        return value;
    }
    if (value instanceof Map) {
        /** @type {Array<any>} */
        const children = [];
        for (const [key, item] of value) {
            children.push(key, item);
        }
        return children;
    }
    if (value instanceof Set) {
        return [...value];
    }
    return Object.values(value);
}

/**
 * 取集合的键值对
 *
 * @param {any} value 集合
 * @returns {Array<[any, any]>} 键值对
 */
function entriesOf(value) {
    if (value instanceof Map) {
        return [...value.entries()];
    }
    if (value instanceof Set) {
        return [...value].map((item) => [item, null]);
    }
    return Object.entries(value);
}

/**
 * 集合是否应写成 `!!set`
 *
 * @param {any} value 值
 * @returns {boolean} 是 Set 返回 true
 */
function isSet(value) {
    return value instanceof Set;
}

/**
 * 集合是否应写成 `!!omap`
 *
 * @param {any} value 值
 * @returns {boolean} 是 Map 返回 true
 */
function isMap(value) {
    return value instanceof Map;
}

/**
 * 判断字符串能否用 plain 样式写出而不改变含义
 *
 * @param {string} text 文本
 * @param {boolean} flowContext 是否流式上下文
 * @param {string} schema 解析表
 * @returns {boolean} 可用 plain 返回 true
 */
function canUsePlain(text, flowContext, schema) {
    if (text === '') {
        return false;
    }
    if (/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/.test(text)) {
        return false;
    }
    if (text !== text.trim()) {
        return false;
    }
    if (text === '---' || text === '...' || text.startsWith('--- ') || text.startsWith('... ')) {
        return false;
    }
    const first = text[0];
    if ('?:-'.includes(first) && (text.length === 1 || text[1] === ' ' || text[1] === '\t')) {
        return false;
    }
    if (',[]{}#&*!|>\'"%@`'.includes(first)) {
        return false;
    }
    if (text.endsWith(':') || text.includes(': ') || text.includes(' #')) {
        return false;
    }
    if (flowContext && /[,[\]{}]/.test(text)) {
        return false;
    }
    if (flowContext && text.includes(':')) {
        return false;
    }
    if (text === '<<') {
        return false;
    }
    return !wouldResolveAsNonString(text, schema);
}

/**
 * 判断字符串能否用单引号样式写出
 *
 * 含制表符或 BOM 的字符串一律走双引号：
 * 制表符虽然能原样放进单引号（规范允许），但输出里与空格难以区分；BOM 更是会被工具"看不见地"吃掉，
 * 转义成 `\t` / `\uFEFF` 后语义明确。
 *
 * @param {string} text 文本
 * @returns {boolean} 可用单引号返回 true
 */
function canUseSingle(text) {
    return !/[\u0000-\u001F\u007F-\u009F\u2028\u2029\uFEFF]/.test(text);
}

/**
 * 转义为双引号样式的内容
 *
 * @param {string} text 文本
 * @returns {string} 双引号标量文本
 */
function doubleQuote(text) {
    let out = '"';
    for (const ch of text) {
        switch (ch) {
            case '"':
                out += '\\"';
                break;
            case '\\':
                out += '\\\\';
                break;
            case '\0':
                out += '\\0';
                break;
            case '\x07':
                out += '\\a';
                break;
            case '\b':
                out += '\\b';
                break;
            case '\t':
                out += '\\t';
                break;
            case '\n':
                out += '\\n';
                break;
            case '\x0B':
                out += '\\v';
                break;
            case '\x0C':
                out += '\\f';
                break;
            case '\r':
                out += '\\r';
                break;
            case '\x1B':
                out += '\\e';
                break;
            case '\u0085':
                out += '\\N';
                break;
            case '\u00A0':
                out += '\\_';
                break;
            case '\u2028':
                out += '\\L';
                break;
            case '\u2029':
                out += '\\P';
                break;
            default: {
                const code = ch.codePointAt(0) ?? 0;
                if (code < 0x20 || code === 0x7F || (code >= 0x80 && code <= 0x9F)) {
                    out += `\\x${code.toString(16).padStart(2, '0')}`;
                } else if (code === 0xFEFF) {
                    out += '\\uFEFF';
                } else if (code >= 0xD800 && code <= 0xDFFF) {
                    out += `\\u${code.toString(16).padStart(4, '0')}`;
                } else {
                    out += ch;
                }
                break;
            }
        }
    }
    return `${out}"`;
}

/**
 * 数值 → YAML 标量文本
 *
 * @param {number} value 数值
 * @returns {string} 文本
 */
function formatNumber(value) {
    if (Number.isNaN(value)) {
        return '.nan';
    }
    if (value === Number.POSITIVE_INFINITY) {
        return '.inf';
    }
    if (value === Number.NEGATIVE_INFINITY) {
        return '-.inf';
    }
    if (Object.is(value, -0)) {
        // `-0` 写成整数形态时会被整数解析吃掉符号（BigInt 没有 -0），改用浮点形态
        return '-0.0';
    }
    return String(value);
}

/**
 * 判断字符串能否用块字面量（`|`）写出
 *
 * 条件：有换行、至少有内容、不含会被行归一化破坏的字符、没有"只有空白但非空"的行、
 * 不以空白开头、行尾不带空白——任一条不满足就退回双引号（照样 round-trip，只是不好看）。
 *
 * @param {string} value 字符串
 * @returns {boolean} 可用块字面量返回 true
 */
function canUseBlockLiteral(value) {
    if (!value.includes('\n') || value.replace(/\n/g, '') === '') {
        return false;
    }
    if (/[\r\u0085\u2028\u2029\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) {
        return false;
    }
    if (/^[ \t]/.test(value)) {
        return false;
    }
    for (const line of value.split('\n')) {
        if (line !== '' && /[ \t]+$/.test(line)) {
            return false;
        }
        if (line !== '' && line.trim() === '') {
            return false;
        }
    }
    return true;
}

/**
 * YAML 序列化器
 *
 * 契约摘要：`stringify()` 返回以 `\n` 结尾的文本；不可序列化的值（无效 `Date`、
 * 关闭重复引用别名时出现的环状结构）抛 `YamlError`（kind 为 `stringify`，带 `path`）。
 *
 * 常用入口：stringify。
 */
class Stringifier {
    /**
     * @type {Readonly<Record<string, any>>}
     */
    #options;

    /**
     * 已写出的锚点：对象 → 锚点名
     * @type {Map<any, string>}
     */
    #anchors = new Map();

    /**
     * 需要锚点的对象集合
     * @type {Set<any>}
     */
    #needAnchor = new Set();

    /**
     * 锚点编号
     * @type {number}
     */
    #counter = 0;

    /**
     * @param {Readonly<Record<string, any>>} options 序列化选项
     */
    constructor(options) {
        this.#options = options;
    }

    /**
     * 序列化一个值
     *
     * @param {any} value JS 值
     * @returns {string} YAML 文本
     */
    stringify(value) {
        this.#analyze(value);
        const formatted = this.#format(value, 0, [], false);
        if (formatted.inline !== undefined) {
            return `${formatted.inline}\n`;
        }
        const head = formatted.head === undefined || formatted.head === '' ? '' : `${formatted.head}\n`;
        return `${head}${formatted.body ?? ''}\n`;
    }

    /**
     * 预扫描：找出需要锚点的对象（重复引用 / 环）
     *
     * @param {any} value 根值
     * @returns {void}
     */
    #analyze(value) {
        /** @type {Map<any, number>} */
        const counts = new Map();
        /** @type {Set<any>} */
        const cyclic = new Set();

        /**
         * @param {any} current 当前值
         * @param {Set<any>} path 当前路径上的对象
         * @returns {void}
         */
        const visit = (current, path) => {
            if (!isCollection(current)) {
                return;
            }
            const count = (counts.get(current) ?? 0) + 1;
            counts.set(current, count);
            if (path.has(current)) {
                cyclic.add(current);
                return;
            }
            if (count > 1) {
                return;
            }
            path.add(current);
            for (const child of childrenOf(current)) {
                visit(child, path);
            }
            path.delete(current);
        };

        visit(value, new Set());

        for (const [object, count] of counts) {
            if (cyclic.has(object)) {
                this.#needAnchor.add(object);
            } else if (count > 1 && this.#options.aliasDuplicateObjects) {
                this.#needAnchor.add(object);
            }
        }
    }

    /**
     * 取缩进文本
     *
     * @param {number} level 缩进层级
     * @returns {string} 缩进
     */
    #pad(level) {
        return ' '.repeat(Math.max(level, 0) * this.#options.indent);
    }

    /**
     * 取消引用 / 登记锚点
     *
     * @param {any} value 集合值
     * @param {Array<string|number>} path 值路径
     * @returns {{alias: string}|{anchor: string}|null} 别名文本、锚点文本或 null
     */
    #anchorFor(value, path) {
        if (!isCollection(value)) {
            return null;
        }
        const existing = this.#anchors.get(value);
        if (existing !== undefined) {
            return { alias: `*${existing}` };
        }
        if (!this.#needAnchor.has(value)) {
            return null;
        }
        this.#counter += 1;
        const name = `ref${this.#counter}`;
        this.#anchors.set(value, name);
        return { anchor: `&${name}` };
    }

    /**
     * 格式化任意值
     *
     * @param {any} value 值
     * @param {number} level 该值在块上下文里的缩进层级
     * @param {Array<string|number>} path 值路径
     * @param {boolean} flowContext 是否位于流式集合内
     * @returns {FormattedNode} 格式化结果
     */
    #format(value, level, path, flowContext) {
        if (value === undefined || value === null) {
            return { inline: 'null' };
        }
        switch (typeof value) {
            case 'boolean':
                return { inline: value ? 'true' : 'false' };
            case 'number':
                return { inline: formatNumber(value) };
            case 'bigint':
                return { inline: value.toString() };
            case 'string':
                return this.#formatString(value, level, path, flowContext);
            case 'function':
            case 'symbol':
                return { inline: 'null' };
            case 'object':
                break;
            default:
                return { inline: 'null' };
        }

        if (value instanceof Date) {
            if (Number.isNaN(value.getTime())) {
                throw new YamlError('stringify', 'Date 是无效时间（getTime() 为 NaN）', { path });
            }
            return { inline: `!!timestamp ${value.toISOString()}` };
        }
        if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
            const base64 = Buffer.from(value).toString('base64');
            if (base64 === '') {
                return { inline: '!!binary ""' };
            }
            const width = this.#options.lineWidth;
            if (!flowContext && width > 0 && base64.length > width) {
                // 长字节串用块字面量分块，避免写出一行几 MB 的文本（规范里的 canonical 形态）
                /** @type {string[]} */
                const chunks = [];
                for (let index = 0; index < base64.length; index += width) {
                    chunks.push(base64.slice(index, index + width));
                }
                const pad = this.#pad(level === 0 ? 1 : level);
                return { head: '!!binary |', body: chunks.map((chunk) => pad + chunk).join('\n') };
            }
            return { inline: `!!binary ${base64}` };
        }
        if (isCollection(value)) {
            return this.#formatCollection(value, level, path, flowContext);
        }
        return { inline: 'null' };
    }

    /**
     * 格式化字符串
     *
     * @param {string} value 字符串
     * @param {number} level 缩进层级
     * @param {Array<string|number>} path 值路径
     * @param {boolean} flowContext 是否流式上下文
     * @param {boolean} [asKey] 是否作为键（键不能用块字面量）
     * @returns {FormattedNode} 格式化结果
     */
    #formatString(value, level, path, flowContext, asKey = false) {
        if (!asKey && !flowContext && canUseBlockLiteral(value)) {
            return this.#blockLiteral(value, level);
        }
        return { inline: this.#inlineString(value, flowContext, level, asKey) };
    }

    /**
     * 单行字符串文本
     *
     * @param {string} value 字符串
     * @param {boolean} flowContext 是否流式上下文
     * @param {number} level 缩进层级
     * @param {boolean} asKey 是否作为键
     * @returns {string} 文本
     */
    #inlineString(value, flowContext, level, asKey) {
        if (value === '') {
            return "''";
        }
        // 流式上下文里不折行：流式标量跨行虽然合法，但可读性与风险都不划算
        const lineWidth = flowContext ? 0 : this.#options.lineWidth;
        if (canUsePlain(value, flowContext, this.#options.schema)) {
            return this.#foldPlain(value, level, asKey, lineWidth);
        }
        if (canUseSingle(value)) {
            return this.#foldQuoted(`'${value.replace(/'/g, "''")}'`, level, asKey, '\'', lineWidth);
        }
        return this.#foldQuoted(doubleQuote(value), level, asKey, '"', lineWidth);
    }

    /**
     * 块字面量文本
     *
     * @param {string} value 字符串
     * @param {number} level 缩进层级
     * @returns {FormattedNode} 格式化结果
     */
    #blockLiteral(value, level) {
        const trailing = /(\n+)$/.exec(value);
        const trailingCount = trailing === null ? 0 : trailing[1].length;
        const header = trailingCount === 0 ? '|-' : (trailingCount === 1 ? '|' : '|+');

        const lines = value.split('\n');
        const contentLines = value.endsWith('\n') ? lines.slice(0, -1) : lines;
        // 根文档里的块标量也必须缩进：内容列至少 1，否则内容与 `|-` 顶格，人读起来容易误解
        const pad = this.#pad(level === 0 ? 1 : level);
        const body = contentLines.map((line) => (line === '' ? '' : pad + line)).join('\n');
        return { head: header, body };
    }

    /**
     * plain 标量折行
     *
     * 只在"空格后面紧跟字母数字"的位置折行：折行处会被解析回空格，语义不变。
     *
     * @param {string} value 文本
     * @param {number} level 缩进层级
     * @param {boolean} asKey 是否作为键
     * @param {number} lineWidth 生效行宽（0 表示不折）
     * @returns {string} 文本
     */
    #foldPlain(value, level, asKey, lineWidth) {
        if (asKey || lineWidth === 0 || value.length <= lineWidth) {
            return value;
        }
        const pad = this.#pad(level);
        let out = '';
        let column = pad.length;
        for (let index = 0; index < value.length; index += 1) {
            const ch = value[index];
            if (ch === ' ' && column >= lineWidth
                && /^[A-Za-z0-9_]/.test(value[index + 1] ?? '')) {
                out += `\n${pad}`;
                column = pad.length;
                continue;
            }
            out += ch;
            column += 1;
        }
        return out;
    }

    /**
     * 引号标量折行
     *
     * 单引号：在空格处折行（解析回来仍是空格）。
     * 双引号：在空格后插入 `\` + 换行（转义换行不产生字符，前面的空格保留）。
     *
     * @param {string} quoted 已加引号的文本
     * @param {number} level 缩进层级
     * @param {boolean} asKey 是否作为键
     * @param {string} quote 引号字符
     * @param {number} lineWidth 生效行宽（0 表示不折）
     * @returns {string} 文本
     */
    #foldQuoted(quoted, level, asKey, quote, lineWidth) {
        if (asKey || lineWidth === 0 || quoted.length <= lineWidth) {
            return quoted;
        }
        const pad = this.#pad(level);
        const inner = quoted.slice(1, -1);
        let out = quote;
        let column = pad.length + 1;
        for (const ch of inner) {
            if (ch === ' ' && column >= lineWidth) {
                out += quote === '"' ? ` \\\n${pad}` : `\n${pad}`;
                column = pad.length;
                continue;
            }
            out += ch;
            column += 1;
        }
        return out + quote;
    }

    /**
     * 格式化集合
     *
     * @param {any} value 集合
     * @param {number} level 缩进层级
     * @param {Array<string|number>} path 值路径
     * @param {boolean} flowContext 是否流式上下文
     * @returns {FormattedNode} 格式化结果
     */
    #formatCollection(value, level, path, flowContext) {
        const anchor = this.#anchorFor(value, path);
        if (anchor !== null && 'alias' in anchor) {
            return { inline: anchor.alias };
        }

        /** @type {string[]} */
        const prefixParts = [];
        if (isSet(value)) {
            prefixParts.push('!!set');
        } else if (isMap(value)) {
            prefixParts.push('!!omap');
        }
        if (anchor !== null && 'anchor' in anchor) {
            prefixParts.push(anchor.anchor);
        }
        const head = prefixParts.join(' ');

        if (Array.isArray(value)) {
            return this.#formatSequence(value, level, path, flowContext, head);
        }
        return this.#formatMapping(value, level, path, flowContext, head);
    }

    /**
     * 格式化序列
     *
     * @param {Array<any>} value 数组
     * @param {number} level 缩进层级
     * @param {Array<string|number>} path 值路径
     * @param {boolean} flowContext 是否流式上下文
     * @param {string} head 前缀（标签 / 锚点）
     * @returns {FormattedNode} 格式化结果
     */
    #formatSequence(value, level, path, flowContext, head) {
        if (value.length === 0) {
            return { inline: `${head === '' ? '' : `${head} `}[]` };
        }

        const flow = flowContext || level <= this.#options.flowLevel;
        if (flow) {
            const parts = value.map((item, index) => this.#formatInline(item, level + 1, path.concat([index]), true));
            return { inline: `${head === '' ? '' : `${head} `}${this.#flowCollection('[', ']', ' ', parts, level)}` };
        }

        const pad = this.#pad(level);
        const innerPad = this.#pad(level + 1);
        const alignedPad = ' '.repeat(pad.length + 2);
        const lines = value.map((item, index) => {
            const formatted = this.#format(item, level + 1, path.concat([index]), false);
            if (formatted.inline !== undefined) {
                return `${pad}- ${formatted.inline}`;
            }
            const headText = formatted.head === undefined || formatted.head === '' ? '' : ` ${formatted.head}`;
            if (headText !== '') {
                // 有标签 / 锚点首行（如 `- |`、`- &ref1`）：首行留在 `- ` 之后，正文照原缩进
                return `${pad}-${headText}\n${formatted.body ?? ''}`;
            }
            // 纯块集合：把正文首行提到 `- ` 之后，其余行对齐到同一列（`- a: 1` 这种常见写法）
            const bodyLines = (formatted.body ?? '').split('\n');
            const [firstLine, ...restLines] = bodyLines;
            const first = firstLine.startsWith(innerPad) ? firstLine.slice(innerPad.length) : firstLine;
            const rest = restLines.map((line) => (line.startsWith(innerPad) ? alignedPad + line.slice(innerPad.length) : line));
            return `${pad}- ${first}${rest.length === 0 ? '' : `\n${rest.join('\n')}`}`;
        });
        return { head, body: lines.join('\n') };
    }

    /**
     * 格式化映射 / Set / Map
     *
     * @param {any} value 集合
     * @param {number} level 缩进层级
     * @param {Array<string|number>} path 值路径
     * @param {boolean} flowContext 是否流式上下文
     * @param {string} head 前缀（标签 / 锚点）
     * @returns {FormattedNode} 格式化结果
     */
    #formatMapping(value, level, path, flowContext, head) {
        let entries = entriesOf(value);
        if (this.#options.sortKeys !== false) {
            const compare = typeof this.#options.sortKeys === 'function'
                ? this.#options.sortKeys
                : (a, b) => (String(a) < String(b) ? -1 : (String(a) > String(b) ? 1 : 0));
            entries = [...entries].sort((left, right) => compare(left[0], right[0]));
        }

        if (entries.length === 0) {
            return { inline: `${head === '' ? '' : `${head} `}{}` };
        }

        const flow = flowContext || level <= this.#options.flowLevel;
        if (flow) {
            const parts = entries.map(([key, item]) => {
                const keyText = this.#formatKey(key, level + 1, path.concat([String(key)]));
                const valueText = this.#formatInline(item, level + 1, path.concat([String(key)]), true);
                return `${keyText}: ${valueText}`;
            });
            return { inline: `${head === '' ? '' : `${head} `}${this.#flowCollection('{', '}', ' ', parts, level)}` };
        }

        const pad = this.#pad(level);
        /** @type {string[]} */
        const lines = [];
        for (const [key, item] of entries) {
            const itemPath = path.concat([String(key)]);
            const keyFormatted = this.#formatKeyNode(key, level, itemPath);
            const valueFormatted = this.#format(item, level + 1, itemPath, false);

            if (keyFormatted.inline !== undefined) {
                if (valueFormatted.inline !== undefined) {
                    lines.push(`${pad}${keyFormatted.inline}: ${valueFormatted.inline}`);
                } else {
                    const headText = valueFormatted.head === undefined || valueFormatted.head === '' ? '' : ` ${valueFormatted.head}`;
                    lines.push(`${pad}${keyFormatted.inline}:${headText}\n${valueFormatted.body ?? ''}`);
                }
                continue;
            }

            // 复杂键：`? 键` / `: 值` 形式
            if (keyFormatted.head === undefined || keyFormatted.head === '') {
                lines.push(`${pad}?\n${keyFormatted.body ?? ''}`);
            } else {
                lines.push(`${pad}? ${keyFormatted.head}\n${keyFormatted.body ?? ''}`);
            }
            if (valueFormatted.inline !== undefined) {
                lines.push(`${pad}: ${valueFormatted.inline}`);
            } else {
                const headText = valueFormatted.head === undefined || valueFormatted.head === '' ? '' : ` ${valueFormatted.head}`;
                lines.push(`${pad}:${headText}\n${valueFormatted.body ?? ''}`);
            }
        }
        return { head, body: lines.join('\n') };
    }

    /**
     * 流式映射里的键文本（必须是单行）
     *
     * @param {any} key 键
     * @param {number} level 缩进层级
     * @param {Array<string|number>} path 值路径
     * @returns {string} 键文本
     */
    #formatKey(key, level, path) {
        const formatted = this.#formatKeyNode(key, level, path);
        if (formatted.inline !== undefined) {
            return formatted.inline;
        }
        // 流式集合里放不下多行键，只能退回双引号字符串
        return doubleQuote(typeof key === 'string' ? key : String(key));
    }

    /**
     * 块映射里的键（字符串键强制单行，集合键走复杂键形式）
     *
     * @param {any} key 键
     * @param {number} level 缩进层级
     * @param {Array<string|number>} path 值路径
     * @returns {FormattedNode} 格式化结果
     */
    #formatKeyNode(key, level, path) {
        if (typeof key === 'string') {
            return this.#formatString(key, level, path, false, true);
        }
        return this.#format(key, level, path, false);
    }

    /**
     * 取值的单行文本（流式集合元素与流式键值使用）
     *
     * @param {any} value 值
     * @param {number} level 缩进层级
     * @param {Array<string|number>} path 值路径
     * @param {boolean} flowContext 是否流式上下文
     * @returns {string} 单行文本
     */
    #formatInline(value, level, path, flowContext) {
        if (typeof value === 'string') {
            return this.#inlineString(value, flowContext, level, false);
        }
        const formatted = this.#format(value, level, path, flowContext);
        if (formatted.inline !== undefined) {
            return formatted.inline;
        }
        const head = formatted.head === undefined || formatted.head === '' ? '' : `${formatted.head}\n`;
        return `${head}${formatted.body ?? ''}`;
    }

    /**
     * 流式集合文本（超宽时逐元素换行）
     *
     * @param {string} open 开始括号
     * @param {string} close 结束括号
     * @param {string} space 括号内的填充（保持 `{ a: b }` 风格）
     * @param {Array<string>} parts 元素文本
     * @param {number} level 缩进层级
     * @returns {string} 文本
     */
    #flowCollection(open, close, space, parts, level) {
        const single = `${open}${space}${parts.join(', ')}${space}${close}`;
        if (this.#options.lineWidth === 0 || single.length <= this.#options.lineWidth || parts.length < 2) {
            return single;
        }
        const pad = this.#pad(level + 1);
        return `${open}\n${pad}${parts.join(`,\n${pad}`)}${close}`;
    }
}
