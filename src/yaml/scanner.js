/**
 * @fileoverview YAML 扫描器（字符流 → token）
 *
 * 结构对照 libyaml 的 scanner：一次扫描产出 token 队列，维护缩进栈、流式层级与"可能的简单键"，
 * 由 parser.js 在其上做产生式归约。
 *
 * 几个必须记住的机制：
 * - **缩进栈**：`#rollIndent()` / `#unrollIndent()` 在列的边界处产出块集合的起止 token；
 * - **简单键**：`key: value` 里的 `key` 只有在同行、且长度 ≤1024 字符时才是简单键；
 *   发现 `:` 时把 KEY token **插回**队列里键开始的位置，并在块上下文补 BLOCK_MAPPING_START；
 *   键没等到 `:` 就跨行 / 超长时，若该键是必需的（列与块缩进一致）则报错；
 * - **制表符**：只允许出现在不参与缩进的位置（行内、流式上下文）；
 * - **块标量**：`|` / `>` + chomping（clip / `-` / `+`）+ 显式缩进指示符，
 *   自动缩进由首个非空行决定，缩进不足即终止（该行不属于块标量，不能提前消费）；
 * - **行内列号 0 起**：与规范一致；对外错误里再 +1 转成 1 起（见 YamlError）。
 */

import { YamlError } from './yamlError.js';
import { Reader } from './reader.js';

/**
 * token 类型
 * @type {Readonly<Record<string, string>>}
 */
export const TOKEN = Object.freeze({
    STREAM_START: 'STREAM_START',
    STREAM_END: 'STREAM_END',
    DOCUMENT_START: 'DOCUMENT_START',
    DOCUMENT_END: 'DOCUMENT_END',
    BLOCK_SEQUENCE_START: 'BLOCK_SEQUENCE_START',
    BLOCK_MAPPING_START: 'BLOCK_MAPPING_START',
    BLOCK_END: 'BLOCK_END',
    BLOCK_ENTRY: 'BLOCK_ENTRY',
    FLOW_SEQUENCE_START: 'FLOW_SEQUENCE_START',
    FLOW_SEQUENCE_END: 'FLOW_SEQUENCE_END',
    FLOW_MAPPING_START: 'FLOW_MAPPING_START',
    FLOW_MAPPING_END: 'FLOW_MAPPING_END',
    FLOW_ENTRY: 'FLOW_ENTRY',
    KEY: 'KEY',
    VALUE: 'VALUE',
    SCALAR: 'SCALAR',
    ANCHOR: 'ANCHOR',
    ALIAS: 'ALIAS',
    TAG: 'TAG',
    DIRECTIVE: 'DIRECTIVE',
});

/**
 * 默认标签句柄
 * @type {ReadonlyArray<[string, string]>}
 */
const DEFAULT_TAG_DIRECTIVES = [
    ['!', '!'],
    ['!!', 'tag:yaml.org,2002:'],
];

/**
 * 双引号标量里的简单转义
 * @type {Readonly<Record<string, string>>}
 */
const ESCAPE_REPLACEMENTS = Object.freeze({
    0: '\0',
    a: '\x07',
    b: '\x08',
    t: '\t',
    '\t': '\t',
    n: '\n',
    v: '\x0B',
    f: '\x0C',
    r: '\r',
    e: '\x1B',
    ' ': ' ',
    '"': '"',
    '\\': '\\',
    '/': '/',
    N: '\u0085',
    _: '\u00A0',
    L: '\u2028',
    P: '\u2029',
});

/**
 * 双引号标量里的定长十六进制转义
 * @type {Readonly<Record<string, number>>}
 */
const ESCAPE_CODES = Object.freeze({ x: 2, u: 4, U: 8 });

/**
 * 是否空白（不含换行）
 *
 * @param {string} ch 字符（空串表示流结束）
 * @returns {boolean} 是空白返回 true
 */
function isBlank(ch) {
    return ch === ' ' || ch === '\t';
}

/**
 * 是否换行
 *
 * @param {string} ch 字符
 * @returns {boolean} 是换行返回 true
 */
function isBreak(ch) {
    return ch === '\n';
}

/**
 * 是否空白、换行或流结束
 *
 * @param {string} ch 字符
 * @returns {boolean} 是分隔符返回 true
 */
function isBlankOrBreakZ(ch) {
    return ch === '' || ch === ' ' || ch === '\t' || ch === '\n';
}

/**
 * 是否流式指示符
 *
 * @param {string} ch 字符
 * @returns {boolean} 是流式指示符返回 true
 */
function isFlowIndicator(ch) {
    return ch === ',' || ch === '[' || ch === ']' || ch === '{' || ch === '}';
}

/**
 * 是否锚点 / 别名名称字符
 *
 * 采用"字母、数字、`_`、`-`、`.`"的保守集合（与 libyaml 的 IS_ALPHA 同档，另允许 `.`）：
 * 规范允许更宽的集合，但 `:`、`,` 等字符在名字里会让 `&a: b` 这类写法产生歧义。
 *
 * @param {string} ch 字符
 * @returns {boolean} 可作为名称字符返回 true
 */
function isAnchorChar(ch) {
    return /^[A-Za-z0-9_.-]$/.test(ch);
}

/**
 * 是否标签字符（ns-uri-char 去掉 `!` 与流式指示符）
 *
 * @param {string} ch 字符
 * @returns {boolean} 可作为标签字符返回 true
 */
function isTagChar(ch) {
    return /^[A-Za-z0-9;/?:@&=+$_.~*'()#%-]$/.test(ch);
}

/**
 * 解码标签 / 前缀里的 URI 转义
 *
 * @param {string} text 原始文本
 * @returns {string} 解码结果
 */
function decodeUriEscapes(text) {
    if (!text.includes('%')) {
        return text;
    }
    try {
        return decodeURIComponent(text);
    } catch {
        throw new YamlError('scan', '标签里的 URI 转义（%XX）不合法');
    }
}

/**
 * YAML 扫描器
 *
 * 契约摘要：token 只由 `peekToken()` / `getToken()` 取出，二者都会按需继续扫描；
 * 语法错误统一抛 `YamlError`（kind 为 `scan`）。
 *
 * 常用入口：peekToken / getToken。
 */
export class Scanner {
    /**
     * @type {Reader}
     */
    #reader;

    /**
     * @type {string|null}
     */
    #filename;

    /**
     * 待取 token 队列
     * @type {Array<any>}
     */
    #tokens = [];

    /**
     * 已经交付给 parser 的 token 数（用于简单键的绝对编号）
     * @type {number}
     */
    #tokensParsed = 0;

    /**
     * 当前流式层级
     * @type {number}
     */
    #flowLevel = 0;

    /**
     * 当前块缩进列（0 起，-1 表示尚无块上下文）
     * @type {number}
     */
    #indent = -1;

    /**
     * 缩进栈
     * @type {Array<{indent: number, tokenNumber: number}>}
     */
    #indents = [];

    /**
     * 当前位置是否允许开始简单键
     * @type {boolean}
     */
    #simpleKeyAllowed = false;

    /**
     * 各流式层级上"可能的简单键"
     * @type {Map<number, {tokenNumber: number, required: boolean, mark: {index: number, line: number, column: number}}>}
     */
    #simpleKeys = new Map();

    /**
     * 当前文档生效的标签句柄表
     * @type {Map<string, string>}
     */
    #tagDirectives = new Map(DEFAULT_TAG_DIRECTIVES);

    /**
     * 当前文档内已声明的自定义句柄（用于重复声明检查）
     * @type {Set<string>}
     */
    #declaredHandles = new Set();

    /**
     * 当前文档是否已声明 %YAML
     * @type {boolean}
     */
    #yamlVersionSet = false;

    /**
     * 当前文档声明的 YAML 版本（null 表示未声明）
     * @type {{major: number, minor: number}|null}
     */
    #yamlVersion = null;

    /**
     * 是否已产出 STREAM_START
     * @type {boolean}
     */
    #streamStartProduced = false;

    /**
     * 是否已产出 STREAM_END
     * @type {boolean}
     */
    #streamEndProduced = false;

    /**
     * @default options = {}
     * @param {string} text 输入文本
     * @param {{filename?: string|null}} [options] 扫描选项（仅文件名，用于错误定位）
     */
    constructor(text, options = {}) {
        this.#reader = new Reader(text);
        this.#filename = options.filename ?? null;
    }

    /**
     * 取下一个 token（不消费）
     *
     * @returns {any} token；流已结束且队列已空时返回 null
     */
    peekToken() {
        while (!this.#streamEndProduced && this.#needMoreTokens()) {
            this.#fetchNextToken();
        }
        return this.#tokens[0] ?? null;
    }

    /**
     * 是否还需要继续扫描
     *
     * 队列为空要继续；此外，当"可能的简单键"正好占着队首位置时必须**接着往后扫**：
     * `key: value` 里的 KEY token 要插回队首之前的位置，只有先扫到冒号才知道它是键。
     * 少了这一条，parser 会先把 SCALAR 取走，冒号再来时插入位置已经在身后了。
     * （与 libyaml 的 `yaml_parser_fetch_more_tokens` 同一机制。）
     *
     * @returns {boolean} 需要继续扫描返回 true
     */
    #needMoreTokens() {
        if (this.#tokens.length === 0) {
            return true;
        }
        this.#staleSimpleKeys();
        for (const key of this.#simpleKeys.values()) {
            if (key.tokenNumber === this.#tokensParsed) {
                return true;
            }
        }
        return false;
    }

    /**
     * 取下一个 token（消费）
     *
     * @returns {any} token；流已结束且队列已空时返回 null
     */
    getToken() {
        const token = this.peekToken();
        if (token !== null) {
            this.#tokens.shift();
            this.#tokensParsed += 1;
        }
        return token;
    }

    /**
     * 造一个带位置的扫描错误
     *
     * @param {'scan'} kind 错误类别
     * @param {string} reason 固定失败原因
     * @param {{index: number, line: number, column: number}} mark 位置
     * @returns {YamlError} 错误对象
     */
    #error(kind, reason, mark) {
        return new YamlError(kind, reason, {
            line: mark.line,
            column: mark.column + 1,
            offset: mark.index,
            file: this.#filename,
        });
    }

    /**
     * 入队 token
     *
     * @param {any} token token
     * @returns {void}
     */
    #enqueue(token) {
        this.#tokens.push(token);
    }

    /**
     * 把 token 插到绝对编号对应的队列位置
     *
     * @param {number} number 绝对 token 编号
     * @param {any} token token
     * @returns {void}
     */
    #insertToken(number, token) {
        const index = number - this.#tokensParsed;
        if (index < 0 || index > this.#tokens.length) {
            throw new YamlError('scan', '内部错误：简单键回溯位置失效', {
                file: this.#filename,
            });
        }
        this.#tokens.splice(index, 0, token);
    }

    /**
     * 读取下一个 token（或产出结束 / 文档标记等结构性 token）
     *
     * @returns {void}
     */
    #fetchNextToken() {
        if (!this.#streamStartProduced) {
            this.#streamStartProduced = true;
            // 流开头是一个块上下文的"行首"：允许在此开始简单键
            this.#simpleKeyAllowed = true;
            const mark = this.#reader.mark();
            this.#enqueue({ type: TOKEN.STREAM_START, start: mark, end: mark });
            return;
        }

        this.#scanToNextToken();
        this.#staleSimpleKeys();
        this.#unrollIndent(this.#reader.column);

        if (this.#reader.eof()) {
            this.#fetchStreamEnd();
            return;
        }

        const ch = this.#reader.peek();
        const next = this.#reader.peek(1);

        if (this.#reader.column === 0 && ch === '%') {
            this.#fetchDirective();
            return;
        }
        if (this.#reader.column === 0 && this.#isDocumentIndicator('---')) {
            this.#fetchDocumentIndicator(TOKEN.DOCUMENT_START);
            return;
        }
        if (this.#reader.column === 0 && this.#isDocumentIndicator('...')) {
            this.#fetchDocumentIndicator(TOKEN.DOCUMENT_END);
            return;
        }
        if (ch === '[') {
            this.#fetchFlowCollectionStart(TOKEN.FLOW_SEQUENCE_START);
            return;
        }
        if (ch === '{') {
            this.#fetchFlowCollectionStart(TOKEN.FLOW_MAPPING_START);
            return;
        }
        if (ch === ']') {
            this.#fetchFlowCollectionEnd(TOKEN.FLOW_SEQUENCE_END);
            return;
        }
        if (ch === '}') {
            this.#fetchFlowCollectionEnd(TOKEN.FLOW_MAPPING_END);
            return;
        }
        if (ch === ',') {
            this.#fetchFlowEntry();
            return;
        }
        if (ch === '-' && isBlankOrBreakZ(next)) {
            this.#fetchBlockEntry();
            return;
        }
        if (ch === '?' && (this.#flowLevel > 0 || isBlankOrBreakZ(next))) {
            this.#fetchKey();
            return;
        }
        if (ch === ':' && (isBlankOrBreakZ(next) || (this.#flowLevel > 0 && isFlowIndicator(next)))) {
            this.#fetchValue();
            return;
        }
        if (ch === '&' || ch === '*') {
            this.#fetchAnchor(ch === '*');
            return;
        }
        if (ch === '!') {
            this.#fetchTag();
            return;
        }
        if (ch === '|' || ch === '>') {
            this.#fetchBlockScalar(ch === '|');
            return;
        }
        if (ch === '\'') {
            this.#fetchFlowScalar(true);
            return;
        }
        if (ch === '"') {
            this.#fetchFlowScalar(false);
            return;
        }
        if (!isBlankOrBreakZ(ch) && ch !== ',' && ch !== '[' && ch !== ']' && ch !== '{' && ch !== '}'
            && ch !== '#' && ch !== '&' && ch !== '*' && ch !== '!' && ch !== '|' && ch !== '>'
            && ch !== '\'' && ch !== '"' && ch !== '%' && ch !== '@' && ch !== '`') {
            this.#fetchPlainScalar();
            return;
        }

        throw this.#error('scan', '此字符不能作为节点的开头（也可能是块上下文里用制表符做了缩进）', this.#reader.mark());
    }

    /**
     * 是否处于文档标记（`---` / `...`）
     *
     * @param {string} text 标记文本
     * @returns {boolean} 是标记返回 true
     */
    #isDocumentIndicator(text) {
        if (this.#reader.peek(0) !== text[0] || this.#reader.peek(1) !== text[1] || this.#reader.peek(2) !== text[2]) {
            return false;
        }
        return isBlankOrBreakZ(this.#reader.peek(3));
    }

    /**
     * 当前位置之前本行是否只有空白（即正处在"缩进区"）
     *
     * 制表符是否允许只看这一点：规范允许用制表符做**分隔**（`-\tb`、`a:\tb`），
     * 但禁止用制表符做**缩进**（行首缩进区里的制表符一律报错）。
     *
     * @returns {boolean} 处于行首缩进区返回 true
     */
    #atLineIndent() {
        for (let offset = 1; ; offset += 1) {
            const ch = this.#reader.peek(-offset);
            if (ch === '' || ch === '\n') {
                return true;
            }
            if (ch !== ' ' && ch !== '\t') {
                return false;
            }
        }
    }

    /**
     * 跳过空白、注释与换行
     *
     * 制表符只在"不参与缩进"的位置（流式上下文，或本行前面已经有内容）被跳过；
     * 块上下文里行首缩进区的制表符不会被跳过，于是下一步会以"不能作为节点开头"报错——这正是
     * 规范要求的"缩进不能用制表符"。
     *
     * @returns {void}
     */
    #scanToNextToken() {
        const reader = this.#reader;
        for (;;) {
            // 行首的孤立 BOM 按规范忽略
            if (reader.peek() === '\uFEFF') {
                reader.forward();
                continue;
            }
            while (reader.peek() === ' '
                || (reader.peek() === '\t' && (this.#flowLevel > 0 || !this.#simpleKeyAllowed || !this.#atLineIndent()))) {
                reader.forward();
            }
            if (reader.peek() === '#') {
                while (!reader.eof() && reader.peek() !== '\n') {
                    reader.forward();
                }
            }
            if (reader.peek() !== '\n') {
                return;
            }
            reader.forward();
            if (this.#flowLevel === 0) {
                this.#simpleKeyAllowed = true;
            }
        }
    }

    /**
     * 淘汰失效的简单键
     *
     * 简单键必须是单行、且不超过 1024 字符；越过边界时若该键是必需的，说明它没等到 `:`。
     *
     * @returns {void}
     */
    #staleSimpleKeys() {
        const mark = this.#reader.mark();
        for (const [level, key] of this.#simpleKeys) {
            if (key.mark.line < mark.line || key.mark.index + 1024 < mark.index) {
                if (key.required) {
                    throw this.#error('scan', `第 ${key.mark.line} 行的键没有等到对应的 ":"（简单键不能跨行，且不超过 1024 字符）`, key.mark);
                }
                this.#simpleKeys.delete(level);
            }
        }
    }

    /**
     * 记录"当前位置可能是简单键的开始"
     *
     * 位置参数必须是**键内容的起始列**：`required` 表示该列正好等于块缩进（这样的键必须等到 `:`）。
     *
     * @returns {void}
     */
    #saveSimpleKey() {
        if (!this.#simpleKeyAllowed) {
            return;
        }

        const mark = this.#reader.mark();
        const required = this.#flowLevel === 0 && this.#indent === mark.column;
        const number = this.#tokensParsed + this.#tokens.length;

        const existing = this.#simpleKeys.get(this.#flowLevel);
        if (existing !== undefined) {
            if (existing.required) {
                throw this.#error('scan', `第 ${existing.mark.line} 行的键没有等到对应的 ":"`, existing.mark);
            }
            this.#simpleKeys.delete(this.#flowLevel);
        }

        this.#simpleKeys.set(this.#flowLevel, { tokenNumber: number, required, mark });
    }

    /**
     * 去掉当前层级上可能的简单键
     *
     * @default allowMissing = false
     * @param {boolean} [allowMissing] 为 true 时不因"必需键缺失"报错（`:` 已满足该键时使用）
     * @returns {void}
     */
    #removeSimpleKey(allowMissing = false) {
        const key = this.#simpleKeys.get(this.#flowLevel);
        if (key === undefined) {
            return;
        }
        if (key.required && !allowMissing) {
            throw this.#error('scan', `第 ${key.mark.line} 行的键没有等到对应的 ":"`, key.mark);
        }
        this.#simpleKeys.delete(this.#flowLevel);
    }

    /**
     * 在列边界处收拢块缩进
     *
     * @param {number} column 目标列（0 起）
     * @returns {void}
     */
    #unrollIndent(column) {
        if (this.#flowLevel > 0) {
            return;
        }
        while (this.#indent > column) {
            const top = this.#indents.pop();
            this.#indent = top === undefined ? -1 : top.indent;
            const mark = this.#reader.mark();
            this.#enqueue({ type: TOKEN.BLOCK_END, start: mark, end: mark });
        }
    }

    /**
     * 在列边界处开启块集合
     *
     * @param {number} column 目标列（0 起）
     * @param {number} number 需要插入时的绝对 token 编号（-1 表示直接入队）
     * @param {string} type token 类型
     * @param {{index: number, line: number, column: number}} mark 位置
     * @returns {void}
     */
    #rollIndent(column, number, type, mark) {
        if (this.#flowLevel > 0) {
            return;
        }
        if (this.#indent < column) {
            const token = { type, start: mark, end: mark };
            if (number === -1) {
                this.#enqueue(token);
            } else {
                this.#insertToken(number, token);
            }
            this.#indents.push({ indent: this.#indent, tokenNumber: number });
            this.#indent = column;
        }
    }

    /**
     * 产出 STREAM_END
     *
     * @returns {void}
     */
    #fetchStreamEnd() {
        this.#unrollIndent(-1);
        this.#removeSimpleKey();
        this.#simpleKeyAllowed = false;
        const mark = this.#reader.mark();
        this.#enqueue({ type: TOKEN.STREAM_END, start: mark, end: mark });
        this.#streamEndProduced = true;
    }

    /**
     * 扫描 `%` 指令
     *
     * @returns {void}
     */
    #fetchDirective() {
        const start = this.#reader.mark();
        this.#unrollIndent(-1);
        this.#removeSimpleKey();
        this.#simpleKeyAllowed = false;

        const directive = this.#scanDirective();
        this.#enqueue({ type: TOKEN.DIRECTIVE, start, end: this.#reader.mark(), ...directive });
    }

    /**
     * 扫描指令本体
     *
     * @returns {{name: string, major?: number, minor?: number, handle?: string, prefix?: string}} 指令内容
     */
    #scanDirective() {
        const reader = this.#reader;
        const start = reader.mark();
        reader.forward();

        const nameStart = reader.index;
        while (/^[A-Za-z0-9_-]$/.test(reader.peek())) {
            reader.forward();
        }
        const name = reader.slice(nameStart, reader.index);
        if (name === '') {
            throw this.#error('scan', '指令名为空', start);
        }
        if (!isBlankOrBreakZ(reader.peek())) {
            throw this.#error('scan', '指令名之后必须是空白或行结束', reader.mark());
        }

        if (name === 'YAML') {
            this.#skipBlanks();
            const majorStart = reader.index;
            while (/^[0-9]$/.test(reader.peek())) {
                reader.forward();
            }
            if (majorStart === reader.index || reader.peek() !== '.') {
                throw this.#error('scan', '%YAML 指令的版本号格式应为 "主.次"', start);
            }
            const major = Number(reader.slice(majorStart, reader.index));
            reader.forward();
            const minorStart = reader.index;
            while (/^[0-9]$/.test(reader.peek())) {
                reader.forward();
            }
            if (minorStart === reader.index) {
                throw this.#error('scan', '%YAML 指令的版本号格式应为 "主.次"', start);
            }
            const minor = Number(reader.slice(minorStart, reader.index));
            if (!isBlankOrBreakZ(reader.peek())) {
                throw this.#error('scan', '版本号之后必须是空白或行结束', reader.mark());
            }
            if (this.#yamlVersionSet) {
                throw this.#error('scan', '同一个文档里出现重复的 %YAML 指令', start);
            }
            this.#yamlVersionSet = true;
            if (major !== 1) {
                throw this.#error('scan', `不支持的 YAML 版本 ${major}.${minor}（本库实现 1.2，只接受 1.x）`, start);
            }
            this.#yamlVersion = { major, minor };
            this.#finishDirectiveLine();
            return { name, major, minor };
        }

        if (name === 'TAG') {
            this.#skipBlanks();
            const handleStart = reader.index;
            if (reader.peek() !== '!') {
                throw this.#error('scan', '%TAG 指令的句柄必须以 "!" 开头', reader.mark());
            }
            reader.forward();
            if (reader.peek() === '!') {
                reader.forward();
            } else {
                while (/^[A-Za-z0-9-]$/.test(reader.peek())) {
                    reader.forward();
                }
                if (reader.peek() !== '!') {
                    throw this.#error('scan', '%TAG 指令的句柄应写成 !、!! 或 !name!', reader.mark());
                }
                reader.forward();
            }
            const handle = reader.slice(handleStart, reader.index);
            if (!isBlank(reader.peek())) {
                throw this.#error('scan', '%TAG 指令的句柄之后必须是空白', reader.mark());
            }
            this.#skipBlanks();

            const prefixStart = reader.index;
            while (!isBlankOrBreakZ(reader.peek())) {
                reader.forward();
            }
            if (prefixStart === reader.index) {
                throw this.#error('scan', '%TAG 指令的标签前缀为空', reader.mark());
            }
            const prefix = decodeUriEscapes(reader.slice(prefixStart, reader.index));

            if (this.#declaredHandles.has(handle)) {
                throw this.#error('scan', `同一个文档里出现重复的 %TAG 句柄声明（${handle}）`, start);
            }
            this.#declaredHandles.add(handle);
            this.#tagDirectives.set(handle, prefix);

            this.#finishDirectiveLine();
            return { name, handle, prefix };
        }

        // 规范允许的"保留指令"：忽略整行
        while (!reader.eof() && reader.peek() !== '\n') {
            reader.forward();
        }
        if (reader.peek() === '\n') {
            reader.forward();
        }
        return { name };
    }

    /**
     * 跳过行内空白
     *
     * @returns {void}
     */
    #skipBlanks() {
        while (isBlank(this.#reader.peek())) {
            this.#reader.forward();
        }
    }

    /**
     * 收尾指令行：允许空白与注释，之后必须是行结束或流结束
     *
     * @returns {void}
     */
    #finishDirectiveLine() {
        const reader = this.#reader;
        this.#skipBlanks();
        if (reader.peek() === '#') {
            while (!reader.eof() && reader.peek() !== '\n') {
                reader.forward();
            }
        }
        if (reader.eof()) {
            return;
        }
        if (reader.peek() !== '\n') {
            throw this.#error('scan', '指令之后只能是空白、注释或行结束', reader.mark());
        }
        reader.forward();
    }

    /**
     * 扫描 `---` / `...` 文档标记
     *
     * 文档标记会重置缩进、简单键与文档级指令（`%YAML` / `%TAG` 只作用于紧随其后的文档），
     * 并把当前标签句柄表快照进 DOCUMENT_START token，供合成阶段解析标签使用。
     *
     * @param {string} type token 类型
     * @returns {void}
     */
    #fetchDocumentIndicator(type) {
        const start = this.#reader.mark();
        this.#unrollIndent(-1);
        this.#removeSimpleKey();
        this.#simpleKeyAllowed = false;
        this.#reader.forward(3);

        /** @type {Record<string, any>} */
        const token = { type, start, end: this.#reader.mark() };

        if (type === TOKEN.DOCUMENT_START) {
            token.tagDirectives = new Map(this.#tagDirectives);
            token.yamlVersion = this.#yamlVersion;
            this.#tagDirectives = new Map(DEFAULT_TAG_DIRECTIVES);
            this.#declaredHandles = new Set();
            this.#yamlVersionSet = false;
            this.#yamlVersion = null;
        }

        this.#enqueue(token);
    }

    /**
     * 扫描 `[` / `{`
     *
     * @param {string} type token 类型
     * @returns {void}
     */
    #fetchFlowCollectionStart(type) {
        this.#saveSimpleKey();
        this.#flowLevel += 1;
        this.#simpleKeyAllowed = true;

        const start = this.#reader.mark();
        this.#reader.forward();
        this.#enqueue({ type, start, end: this.#reader.mark() });
    }

    /**
     * 扫描 `]` / `}`
     *
     * @param {string} type token 类型
     * @returns {void}
     */
    #fetchFlowCollectionEnd(type) {
        if (this.#flowLevel === 0) {
            throw this.#error('scan', '流式集合的结束指示符没有对应的开始指示符', this.#reader.mark());
        }
        this.#removeSimpleKey();
        this.#flowLevel -= 1;
        this.#simpleKeyAllowed = false;

        const start = this.#reader.mark();
        this.#reader.forward();
        this.#enqueue({ type, start, end: this.#reader.mark() });
    }

    /**
     * 扫描 `,`
     *
     * @returns {void}
     */
    #fetchFlowEntry() {
        if (this.#flowLevel === 0) {
            throw this.#error('scan', '流式条目指示符 "," 不能出现在块上下文里', this.#reader.mark());
        }
        this.#removeSimpleKey();
        this.#simpleKeyAllowed = true;

        const start = this.#reader.mark();
        this.#reader.forward();
        this.#enqueue({ type: TOKEN.FLOW_ENTRY, start, end: this.#reader.mark() });
    }

    /**
     * 扫描 `- ` 块序列条目
     *
     * @returns {void}
     */
    #fetchBlockEntry() {
        const start = this.#reader.mark();
        if (this.#flowLevel > 0) {
            throw this.#error('scan', '块序列条目 "-" 不能出现在流式集合里', start);
        }
        if (!this.#simpleKeyAllowed) {
            throw this.#error('scan', '此处不允许出现块序列条目 "-"（前面已经有节点了）', start);
        }
        this.#rollIndent(start.column, -1, TOKEN.BLOCK_SEQUENCE_START, start);
        this.#reader.forward();
        this.#simpleKeyAllowed = true;
        this.#enqueue({ type: TOKEN.BLOCK_ENTRY, start, end: this.#reader.mark() });
    }

    /**
     * 扫描 `?` 显式键
     *
     * @returns {void}
     */
    #fetchKey() {
        const start = this.#reader.mark();
        if (this.#flowLevel === 0) {
            if (!this.#simpleKeyAllowed) {
                throw this.#error('scan', '此处不允许出现映射键 "?"（前面已经有节点了）', start);
            }
            this.#rollIndent(start.column, -1, TOKEN.BLOCK_MAPPING_START, start);
        }
        this.#reader.forward();
        this.#removeSimpleKey();
        this.#simpleKeyAllowed = true;
        this.#enqueue({ type: TOKEN.KEY, start, end: this.#reader.mark() });
    }

    /**
     * 扫描 `: ` 映射值
     *
     * @returns {void}
     */
    #fetchValue() {
        const start = this.#reader.mark();
        const key = this.#simpleKeys.get(this.#flowLevel);

        if (key !== undefined) {
            const keyMark = key.mark;
            this.#insertToken(key.tokenNumber, { type: TOKEN.KEY, start: keyMark, end: keyMark });
            this.#rollIndent(keyMark.column, key.tokenNumber, TOKEN.BLOCK_MAPPING_START, keyMark);
            this.#removeSimpleKey(true);
            this.#simpleKeyAllowed = false;
        } else {
            if (this.#flowLevel === 0) {
                if (!this.#simpleKeyAllowed) {
                    throw this.#error('scan', '此处不允许出现映射值 ":"', start);
                }
                this.#rollIndent(start.column, -1, TOKEN.BLOCK_MAPPING_START, start);
            }
            this.#simpleKeyAllowed = this.#flowLevel === 0;
        }

        this.#reader.forward();
        this.#enqueue({ type: TOKEN.VALUE, start, end: this.#reader.mark() });
    }

    /**
     * 扫描 `&` 锚点 / `*` 别名
     *
     * @param {boolean} alias 是否别名
     * @returns {void}
     */
    #fetchAnchor(alias) {
        this.#saveSimpleKey();
        this.#simpleKeyAllowed = false;

        const reader = this.#reader;
        const start = reader.mark();
        reader.forward();

        const nameStart = reader.index;
        while (isAnchorChar(reader.peek())) {
            reader.forward();
        }
        if (nameStart === reader.index) {
            throw this.#error('scan', alias ? '别名的名称为空' : '锚点的名称为空', start);
        }
        const value = reader.slice(nameStart, reader.index);
        this.#enqueue({
            type: alias ? TOKEN.ALIAS : TOKEN.ANCHOR,
            value,
            start,
            end: reader.mark(),
        });
    }

    /**
     * 扫描 `!` 标签
     *
     * @returns {void}
     */
    #fetchTag() {
        this.#saveSimpleKey();
        this.#simpleKeyAllowed = false;

        const start = this.#reader.mark();
        const tag = this.#scanTag();
        this.#enqueue({ type: TOKEN.TAG, start, end: this.#reader.mark(), ...tag });
    }

    /**
     * 扫描标签本体
     *
     * @returns {{handle: string|null, suffix: string}} 句柄（verbatim 时为 null）与后缀
     */
    #scanTag() {
        const reader = this.#reader;
        const start = reader.mark();
        reader.forward();

        if (reader.peek() === '<') {
            reader.forward();
            const textStart = reader.index;
            while (!reader.eof() && reader.peek() !== '>') {
                reader.forward();
            }
            if (reader.eof()) {
                throw this.#error('scan', 'verbatim 标签缺少结束的 ">"', start);
            }
            const suffix = reader.slice(textStart, reader.index);
            if (suffix === '') {
                throw this.#error('scan', 'verbatim 标签的内容为空', start);
            }
            reader.forward();
            if (!isBlankOrBreakZ(reader.peek()) && !isFlowIndicator(reader.peek())) {
                throw this.#error('scan', '标签之后必须是空白、流式指示符或行结束', reader.mark());
            }
            return { handle: null, suffix };
        }

        let handle = '!';
        if (reader.peek() === '!') {
            handle = '!!';
            reader.forward();
        } else {
            const nameStart = reader.index;
            let offset = 0;
            while (isTagChar(reader.peek(offset))) {
                offset += 1;
            }
            if (offset > 0 && reader.peek(offset) === '!') {
                const name = reader.slice(nameStart, nameStart + offset);
                if (!/^[A-Za-z0-9-]*$/.test(name)) {
                    throw this.#error('scan', '标签句柄名只能由字母、数字与 "-" 组成', start);
                }
                handle = `!${name}!`;
                reader.forward(offset + 1);
            }
        }

        const suffixStart = reader.index;
        while (isTagChar(reader.peek())) {
            reader.forward();
        }
        const suffix = decodeUriEscapes(reader.slice(suffixStart, reader.index));
        if (handle !== '!' && suffix === '') {
            throw this.#error('scan', '标签句柄之后缺少后缀', start);
        }
        if (!isBlankOrBreakZ(reader.peek()) && !isFlowIndicator(reader.peek())) {
            throw this.#error('scan', '标签之后必须是空白、流式指示符或行结束', reader.mark());
        }
        return { handle, suffix };
    }

    /**
     * 扫描块标量
     *
     * @param {boolean} literal true 为 `|`（字面），false 为 `>`（折叠）
     * @returns {void}
     */
    #fetchBlockScalar(literal) {
        if (this.#flowLevel > 0) {
            throw this.#error('scan', '块标量不能出现在流式集合里', this.#reader.mark());
        }
        this.#removeSimpleKey();

        const start = this.#reader.mark();
        const value = this.#scanBlockScalar(literal);
        this.#enqueue({
            type: TOKEN.SCALAR,
            value,
            style: literal ? '|' : '>',
            start,
            end: this.#reader.mark(),
        });

        // 块标量一定在行边界结束，下一行可以重新开始简单键
        this.#simpleKeyAllowed = true;
    }

    /**
     * 扫描块标量本体
     *
     * @param {boolean} literal 是否字面样式
     * @returns {string} 标量值
     */
    #scanBlockScalar(literal) {
        const reader = this.#reader;
        const start = reader.mark();
        reader.forward();

        let chomping = 'clip';
        let increment = 0;
        let seenChomping = false;
        let seenIncrement = false;

        for (;;) {
            const ch = reader.peek();
            if (!seenChomping && (ch === '+' || ch === '-')) {
                chomping = ch === '+' ? 'keep' : 'strip';
                seenChomping = true;
                reader.forward();
                continue;
            }
            if (!seenIncrement && /^[0-9]$/.test(ch)) {
                if (ch === '0') {
                    throw this.#error('scan', '块标量的缩进指示符不能是 0', reader.mark());
                }
                increment = Number(ch);
                seenIncrement = true;
                reader.forward();
                continue;
            }
            break;
        }

        this.#skipBlanks();
        if (reader.peek() === '#') {
            while (!reader.eof() && reader.peek() !== '\n') {
                reader.forward();
            }
        }
        if (!reader.eof() && reader.peek() !== '\n') {
            throw this.#error('scan', '块标量的头部之后必须是行结束', reader.mark());
        }
        if (reader.peek() === '\n') {
            reader.forward();
        }

        const parentIndent = this.#indent;
        /** @type {number|null} */
        let contentIndent = increment > 0
            ? (parentIndent >= 0 ? parentIndent + increment : increment)
            : null;

        /** @type {Array<{text: string, terminated: boolean}>} */
        const lines = [];

        for (;;) {
            if (reader.eof()) {
                break;
            }

            let spaces = 0;
            while (reader.peek(spaces) === ' ') {
                spaces += 1;
            }
            const rest = reader.peek(spaces);
            const blankLine = rest === '\n' || rest === '';

            if (contentIndent === null) {
                if (blankLine) {
                    lines.push({ text: '', terminated: rest === '\n' });
                    reader.forward(spaces);
                    if (rest === '\n') {
                        reader.forward();
                    } else {
                        break;
                    }
                    continue;
                }
                if (spaces <= parentIndent) {
                    break;
                }
                contentIndent = spaces;
            }

            if (!blankLine && spaces < contentIndent) {
                break;
            }

            reader.forward(blankLine ? Math.min(spaces, contentIndent) : contentIndent);
            let text = '';
            while (!reader.eof() && reader.peek() !== '\n') {
                text += reader.peek();
                reader.forward();
            }
            const terminated = reader.peek() === '\n';
            if (terminated) {
                reader.forward();
            }
            lines.push({ text: blankLine ? '' : text, terminated });
            if (!terminated) {
                break;
            }
        }

        let value = literal ? this.#joinLiteral(lines) : this.#foldLines(lines);

        if (chomping === 'strip') {
            value = value.replace(/\n(?:[ \t]*\n)*[ \t]*$/, '');
        } else if (chomping === 'clip') {
            value = value.replace(/\n(?:[ \t]*\n)*$/, '\n');
        }

        if (lines.length === 0 && value === '' && increment === 0 && chomping === 'clip') {
            // 空块标量：不需要额外处理，保留此处注释说明"值就是空串"
            return '';
        }
        return value;
    }

    /**
     * 拼装字面样式（`|`）的块标量值
     *
     * @param {Array<{text: string, terminated: boolean}>} lines 内容行
     * @returns {string} 值（未 chomping）
     */
    #joinLiteral(lines) {
        if (lines.length === 0) {
            return '';
        }
        let value = lines.map((line) => line.text).join('\n');
        const last = lines[lines.length - 1];
        if (last.terminated) {
            value += '\n';
        }
        return value;
    }

    /**
     * 拼装折叠样式（`>`）的块标量值
     *
     * 规则：n 个连续换行在普通行之间折叠成 n-1 个 `\n`（n=1 时折成空格）；
     * 相邻任一行是"更深缩进"（内容自身以空白开头）时换行原样保留；尾部换行交给 chomping。
     *
     * @param {Array<{text: string, terminated: boolean}>} lines 内容行
     * @returns {string} 值（未 chomping）
     */
    #foldLines(lines) {
        let out = '';
        let pendingBlanks = 0;
        let first = true;
        let previousMoreIndented = false;

        for (const line of lines) {
            if (line.text === '') {
                pendingBlanks += 1;
                continue;
            }
            const moreIndented = isBlank(line.text[0]);
            if (first) {
                // 前导空行按字面换行保留（折叠只作用于内容行之间，与字面样式保持同一语义）
                if (pendingBlanks > 0) {
                    out += '\n'.repeat(pendingBlanks);
                }
                out += line.text;
                first = false;
            } else {
                const breaks = pendingBlanks + 1;
                if (previousMoreIndented || moreIndented) {
                    out += '\n'.repeat(breaks);
                } else if (breaks === 1) {
                    out += ' ';
                } else {
                    out += '\n'.repeat(breaks - 1);
                }
                out += line.text;
            }
            previousMoreIndented = moreIndented;
            pendingBlanks = 0;
        }

        const last = lines[lines.length - 1];
        const lastTerminated = last !== undefined && last.terminated;
        if (pendingBlanks > 0 || lastTerminated) {
            out += '\n'.repeat(pendingBlanks + (lastTerminated ? 1 : 0));
        }
        return out;
    }

    /**
     * 扫描引号标量
     *
     * @param {boolean} single 是否单引号
     * @returns {void}
     */
    #fetchFlowScalar(single) {
        this.#saveSimpleKey();
        // 先清标记再扫描：扫描过程中跨行会把标记重新置为 true（新的一行可以开始简单键）
        this.#simpleKeyAllowed = false;

        const start = this.#reader.mark();
        const value = single ? this.#scanSingleQuoted() : this.#scanDoubleQuoted();
        this.#enqueue({
            type: TOKEN.SCALAR,
            value,
            style: single ? '\'' : '"',
            start,
            end: this.#reader.mark(),
        });
    }

    /**
     * 消费引号标量里的连续空白与换行，按规范折叠
     *
     * 行内空白先原样保留（遇到换行再回退），换行按"n 个换行 → n-1 个 `\n`"折叠，
     * 续行缩进被丢弃；返回累计的换行数。
     *
     * @param {{out: string, pending: number}} state 折叠状态
     * @returns {void}
     */
    #consumeQuotedBlanks(state) {
        const reader = this.#reader;
        while (isBlank(reader.peek()) || isBreak(reader.peek())) {
            if (isBlank(reader.peek())) {
                if (state.pending > 0 && reader.peek() === '\t' && reader.column <= this.#indent) {
                    throw this.#error('scan', '引号标量续行缩进处不允许使用制表符', reader.mark());
                }
                if (state.pending === 0) {
                    state.out += reader.peek();
                }
                reader.forward();
            } else {
                if (state.pending === 0) {
                    state.out = state.out.replace(/[ \t]+$/, '');
                }
                state.pending += 1;
                reader.forward();
                // 标量扫描内部消耗了换行：在块上下文里等价于"来到了新行行首"，
                // 下一行可以重新开始一个简单键（`? a\n? b` 这类显式键映射靠这一条成立）
                this.#simpleKeyAllowed = true;
            }
        }
    }

    /**
     * 把待定换行折成空格或换行
     *
     * @param {{out: string, pending: number}} state 折叠状态
     * @returns {void}
     */
    #flushQuotedBlanks(state) {
        if (state.pending > 0) {
            state.out += state.pending === 1 ? ' ' : '\n'.repeat(state.pending - 1);
            state.pending = 0;
        }
    }

    /**
     * 扫描单引号标量
     *
     * @returns {string} 值
     */
    #scanSingleQuoted() {
        const reader = this.#reader;
        const start = reader.mark();
        reader.forward();

        const state = { out: '', pending: 0 };
        for (;;) {
            if (reader.eof()) {
                throw this.#error('scan', '单引号标量没有结束的 "\'"', start);
            }
            const ch = reader.peek();
            if (isBlank(ch) || isBreak(ch)) {
                this.#consumeQuotedBlanks(state);
                continue;
            }
            this.#flushQuotedBlanks(state);
            if (ch === '\'') {
                reader.forward();
                if (reader.peek() === '\'') {
                    reader.forward();
                    state.out += '\'';
                    continue;
                }
                break;
            }
            state.out += ch;
            reader.forward();
        }
        return state.out;
    }

    /**
     * 扫描双引号标量
     *
     * @returns {string} 值
     */
    #scanDoubleQuoted() {
        const reader = this.#reader;
        const start = reader.mark();
        reader.forward();

        const state = { out: '', pending: 0 };
        for (;;) {
            if (reader.eof()) {
                throw this.#error('scan', '双引号标量没有结束的 \'"\'', start);
            }
            const ch = reader.peek();
            if (isBlank(ch) || isBreak(ch)) {
                this.#consumeQuotedBlanks(state);
                continue;
            }
            this.#flushQuotedBlanks(state);

            if (ch === '"') {
                reader.forward();
                break;
            }

            if (ch === '\\') {
                reader.forward();
                const escaped = reader.peek();
                if (escaped === '') {
                    throw this.#error('scan', '双引号标量以未完成的转义结尾', start);
                }
                if (isBreak(escaped)) {
                    // 转义换行：换行与其后的缩进全部丢弃，不产生折叠空格
                    reader.forward();
                    while (isBlank(reader.peek())) {
                        reader.forward();
                    }
                    continue;
                }
                const simple = ESCAPE_REPLACEMENTS[escaped];
                if (simple !== undefined) {
                    state.out += simple;
                    reader.forward();
                    continue;
                }
                const width = ESCAPE_CODES[escaped];
                if (width !== undefined) {
                    reader.forward();
                    let hex = '';
                    for (let index = 0; index < width; index += 1) {
                        const digit = reader.peek();
                        if (!/^[0-9A-Fa-f]$/.test(digit)) {
                            throw this.#error('scan', `\\${escaped} 转义需要 ${width} 位十六进制数字`, reader.mark());
                        }
                        hex += digit;
                        reader.forward();
                    }
                    const codePoint = Number.parseInt(hex, 16);
                    if (codePoint > 0x10FFFF) {
                        throw this.#error('scan', `\\${escaped} 转义超出了 Unicode 范围`, reader.mark());
                    }
                    state.out += String.fromCodePoint(codePoint);
                    continue;
                }
                throw this.#error('scan', `未知的转义序列 \\${escaped}`, reader.mark());
            }

            state.out += ch;
            reader.forward();
        }
        return state.out;
    }

    /**
     * 扫描 plain 标量
     *
     * @returns {void}
     */
    #fetchPlainScalar() {
        this.#saveSimpleKey();
        // 先清标记再扫描：扫描过程中跨行会把标记重新置为 true（新的一行可以开始简单键）
        this.#simpleKeyAllowed = false;

        const start = this.#reader.mark();
        const value = this.#scanPlainScalar();
        this.#enqueue({
            type: TOKEN.SCALAR,
            value,
            style: '',
            start,
            end: this.#reader.mark(),
        });
    }

    /**
     * 扫描 plain 标量本体（含跨行折叠）
     *
     * @returns {string} 值
     */
    #scanPlainScalar() {
        const reader = this.#reader;
        const indent = this.#indent + 1;
        const flow = this.#flowLevel > 0;
        const state = { out: '', pending: 0 };

        for (;;) {
            // 行首的 `---` / `...` 结束 plain 标量（否则 `a\n--- b` 会被吞成一个标量）
            if (reader.column === 0 && (this.#isDocumentIndicator('---') || this.#isDocumentIndicator('...'))) {
                break;
            }
            if (reader.peek() === '#') {
                break;
            }

            while (!isBlankOrBreakZ(reader.peek())) {
                const ch = reader.peek();
                const next = reader.peek(1);
                if (ch === ':' && (isBlankOrBreakZ(next) || (flow && isFlowIndicator(next)))) {
                    break;
                }
                if (flow && isFlowIndicator(ch)) {
                    break;
                }
                this.#flushQuotedBlanks(state);
                state.out += ch;
                reader.forward();
            }

            if (reader.eof()) {
                break;
            }
            if (!isBlank(reader.peek()) && !isBreak(reader.peek())) {
                break;
            }

            this.#consumeQuotedBlanks(state);

            if (!flow && reader.column < indent) {
                break;
            }
            if (reader.eof()) {
                break;
            }
        }

        state.out = state.out.replace(/[ \t]+$/, '');
        return state.out;
    }
}
