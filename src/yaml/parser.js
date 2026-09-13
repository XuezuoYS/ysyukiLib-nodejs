/**
 * @fileoverview YAML 解析器（token → event）
 *
 * 在 scanner 的 token 流上做递归下降，产出与规范第 5–8 章产生式对应的 **event 流**：
 *
 * ```
 * STREAM_START  DOCUMENT_START? SCALAR | SEQUENCE_START ... SEQUENCE_END | MAPPING_START ... MAPPING_END | ALIAS ...
 * ```
 *
 * 事件流与文档信息（`%YAML` 版本、`%TAG` 句柄表、是否显式 `---`）一起交给 composer，
 * 由 composer 负责锚点 / 标签解析并组装成节点图——分层是为了让每一层都能被单独测试。
 *
 * 本层负责的语法约束：
 * - 指令之后必须紧跟 `---`；
 * - 首个文档之后，新文档必须用 `---` 显式分隔；
 * - `? key` 显式键、流式里的"单键隐式映射"（`[a: b]`）、空键 / 空值节点；
 * - `maxDepth` 嵌套深度保护（超限抛 `YamlError` 而不是让调用方吃 `RangeError`）。
 */

import { YamlError } from './yamlError.js';
import { Scanner, TOKEN } from './scanner.js';
import { normalizeParseOptions } from './options.js';

/**
 * event 类型
 * @type {Readonly<Record<string, string>>}
 */
export const EVENT = Object.freeze({
    STREAM_START: 'STREAM_START',
    STREAM_END: 'STREAM_END',
    DOCUMENT_START: 'DOCUMENT_START',
    DOCUMENT_END: 'DOCUMENT_END',
    ALIAS: 'ALIAS',
    SCALAR: 'SCALAR',
    SEQUENCE_START: 'SEQUENCE_START',
    SEQUENCE_END: 'SEQUENCE_END',
    MAPPING_START: 'MAPPING_START',
    MAPPING_END: 'MAPPING_END',
});

/**
 * 默认标签句柄（与 scanner 保持一致，供 `%TAG` 缺省时使用）
 * @type {ReadonlyArray<[string, string]>}
 */
const DEFAULT_TAG_DIRECTIVES = [
    ['!', '!'],
    ['!!', 'tag:yaml.org,2002:'],
];

/**
 * YAML 解析器
 *
 * 契约摘要：`documents()` 一次产出全部文档（每个文档含事件流、指令信息与位置），
 * 语法错误统一抛 `YamlError`（kind 为 `parse`）。
 *
 * 常用入口：documents / events。
 */
export class Parser {
    /**
     * @type {Scanner}
     */
    #scanner;

    /**
     * @type {Readonly<Record<string, any>>}
     */
    #options;

    /**
     * 当前 token
     * @type {any}
     */
    #token = null;

    /**
     * 当前嵌套深度
     * @type {number}
     */
    #depth = 0;

    /**
     * 缓存的文档结果（documents() 只扫描一次）
     * @type {Array<any>|null}
     */
    #documents = null;

    /**
     * @default options = {}
     * @param {string} text 输入文本
     * @param {Record<string, any>} [options] 解析选项（见 options.js）
     */
    constructor(text, options = {}) {
        this.#options = normalizeParseOptions(options);
        this.#scanner = new Scanner(text, { filename: this.#options.filename });
    }

    /**
     * 解析全部文档
     *
     * @returns {Array<{events: Array<any>, tagDirectives: Map<string, string>, version: {major: number, minor: number}|null, explicitStart: boolean, start: {index: number, line: number, column: number}, end: {index: number, line: number, column: number}}>} 文档数组
     */
    documents() {
        if (this.#documents !== null) {
            return this.#documents;
        }

        const documents = [];
        this.#advance();

        if (this.#token === null || this.#token.type !== TOKEN.STREAM_START) {
            throw this.#error('parse', '内部错误：扫描器没有产出流开始标记', this.#token);
        }
        this.#advance();

        let first = true;
        while (this.#token !== null && this.#token.type !== TOKEN.STREAM_END) {
            documents.push(this.#parseDocument(first));
            first = false;
        }

        this.#documents = documents;
        return documents;
    }

    /**
     * 展平的 event 流（含流与文档边界，便于逐事件断言）
     *
     * @returns {Array<any>} event 数组
     */
    events() {
        const events = [{ type: EVENT.STREAM_START }];
        for (const document of this.documents()) {
            events.push({
                type: EVENT.DOCUMENT_START,
                explicit: document.explicitStart,
                version: document.version,
            });
            events.push(...document.events);
            events.push({ type: EVENT.DOCUMENT_END });
        }
        events.push({ type: EVENT.STREAM_END });
        return events;
    }

    /**
     * 取下一个 token 作为当前 token
     *
     * @returns {void}
     */
    #advance() {
        this.#token = this.#scanner.getToken();
    }

    /**
     * 确认当前 token 存在且不是流结束
     *
     * @param {string} reason 固定失败原因
     * @returns {any} 当前 token
     */
    #requireToken(reason) {
        if (this.#token === null || this.#token.type === TOKEN.STREAM_END) {
            throw this.#error('parse', reason, this.#token);
        }
        return this.#token;
    }

    /**
     * 造一个解析错误
     *
     * @param {'parse'|'compose'} kind 错误类别
     * @param {string} reason 固定失败原因
     * @param {any} token 位置来源 token（可为 null）
     * @returns {YamlError} 错误对象
     */
    #error(kind, reason, token) {
        const mark = token?.start;
        return new YamlError(kind, reason, {
            line: mark?.line ?? null,
            column: typeof mark?.column === 'number' ? mark.column + 1 : null,
            offset: mark?.index ?? null,
            file: this.#options.filename,
        });
    }

    /**
     * 解析单个文档
     *
     * @param {boolean} first 是否流中的第一个文档
     * @returns {any} 文档结果
     */
    #parseDocument(first) {
        const events = [];
        const start = this.#token.start;
        let tagDirectives = new Map(DEFAULT_TAG_DIRECTIVES);
        let version = null;
        let explicitStart = false;
        let sawDirective = false;

        while (this.#token !== null && this.#token.type === TOKEN.DIRECTIVE) {
            sawDirective = true;
            if (this.#token.name === 'YAML') {
                version = { major: this.#token.major, minor: this.#token.minor };
            }
            this.#advance();
        }

        if (this.#token !== null && this.#token.type === TOKEN.DOCUMENT_START) {
            explicitStart = true;
            if (this.#token.tagDirectives instanceof Map) {
                tagDirectives = this.#token.tagDirectives;
            }
            if (version === null && this.#token.yamlVersion) {
                version = this.#token.yamlVersion;
            }
            this.#advance();
            if (this.#isDocumentBoundary()) {
                this.#pushEmptyScalar(events, start, null, null);
            } else {
                this.#parseNode(events, true, false, null, null);
            }
        } else {
            if (sawDirective) {
                throw this.#error('parse', '指令之后必须紧跟文档开始标记 "---"', this.#token);
            }
            if (!first) {
                throw this.#error('parse', '第一个文档之后，新文档必须用 "---" 显式分隔', this.#token);
            }
            if (this.#isDocumentBoundary()) {
                throw this.#error('parse', '此处需要节点内容', this.#token);
            }
            this.#parseNode(events, true, false, null, null);
        }

        if (this.#token !== null && this.#token.type === TOKEN.DOCUMENT_END) {
            this.#advance();
        }

        return {
            events,
            tagDirectives,
            version,
            explicitStart,
            start,
            end: this.#token?.start ?? start,
        };
    }

    /**
     * 当前 token 是否处于文档边界
     *
     * @returns {boolean} 处于边界返回 true
     */
    #isDocumentBoundary() {
        if (this.#token === null) {
            return true;
        }
        return this.#token.type === TOKEN.DOCUMENT_START
            || this.#token.type === TOKEN.DOCUMENT_END
            || this.#token.type === TOKEN.STREAM_END
            || this.#token.type === TOKEN.DIRECTIVE;
    }

    /**
     * 压入一个 null 标量事件（空节点）
     *
     * @param {Array<any>} events 事件数组
     * @param {{index: number, line: number, column: number}|undefined} mark 位置
     * @param {string|null} anchor 锚点
     * @param {{handle: string|null, suffix: string}|null} tag 标签
     * @returns {void}
     */
    #pushEmptyScalar(events, mark, anchor, tag) {
        events.push({
            type: EVENT.SCALAR,
            value: '',
            style: '',
            empty: true,
            anchor: anchor ?? null,
            tag: tag ?? null,
            start: mark,
            end: mark,
        });
    }

    /**
     * 解析一个节点（含锚点 / 标签属性）
     *
     * @param {Array<any>} events 事件数组
     * @param {boolean} block 是否块上下文
     * @param {boolean} indentless 是否允许"无 BLOCK_SEQUENCE_START 的块序列"
     * @param {string|null} inheritedAnchor 上层已解析出的锚点
     * @param {{handle: string|null, suffix: string}|null} inheritedTag 上层已解析出的标签
     * @returns {void}
     */
    #parseNode(events, block, indentless, inheritedAnchor, inheritedTag) {
        this.#requireToken('此处需要节点内容，但输入已结束');

        let anchor = inheritedAnchor;
        let tag = inheritedTag;
        let lastMark = this.#token.start;

        while (this.#token !== null && (this.#token.type === TOKEN.ANCHOR || this.#token.type === TOKEN.TAG)) {
            if (this.#token.type === TOKEN.ANCHOR) {
                if (anchor !== null) {
                    throw this.#error('parse', '同一个节点上出现重复的锚点', this.#token);
                }
                anchor = this.#token.value;
            } else {
                if (tag !== null) {
                    throw this.#error('parse', '同一个节点上出现重复的标签', this.#token);
                }
                tag = { handle: this.#token.handle, suffix: this.#token.suffix };
            }
            lastMark = this.#token.end ?? this.#token.start;
            this.#advance();
        }

        if (this.#token === null || this.#isDocumentBoundary()) {
            // 只有属性、没有内容的节点：标签 / 锚点仍生效，值按空节点处理（`!`、`!!str`、`&a` 单独成行）
            this.#pushEmptyScalar(events, lastMark, anchor, tag);
            return;
        }

        const start = this.#token.start;

        if (this.#token.type === TOKEN.ALIAS) {
            if (anchor !== null || tag !== null) {
                throw this.#error('parse', '别名节点不能带锚点或标签', this.#token);
            }
            events.push({
                type: EVENT.ALIAS,
                anchor: this.#token.value,
                start,
                end: this.#token.end,
            });
            this.#advance();
            return;
        }

        if (this.#token.type === TOKEN.SCALAR) {
            events.push({
                type: EVENT.SCALAR,
                value: this.#token.value,
                style: this.#token.style,
                empty: false,
                anchor,
                tag,
                start,
                end: this.#token.end,
            });
            this.#advance();
            return;
        }

        if (indentless && this.#token.type === TOKEN.BLOCK_ENTRY) {
            this.#parseBlockSequence(events, anchor, tag, start, true);
            return;
        }

        switch (this.#token.type) {
            case TOKEN.BLOCK_SEQUENCE_START:
                this.#parseBlockSequence(events, anchor, tag, start, false);
                return;
            case TOKEN.BLOCK_MAPPING_START:
                this.#parseBlockMapping(events, anchor, tag, start);
                return;
            case TOKEN.FLOW_SEQUENCE_START:
                this.#parseFlowSequence(events, anchor, tag, start);
                return;
            case TOKEN.FLOW_MAPPING_START:
                this.#parseFlowMapping(events, anchor, tag, start);
                return;
            default:
                break;
        }

        if (anchor !== null || tag !== null) {
            this.#pushEmptyScalar(events, start, anchor, tag);
            return;
        }

        throw this.#error('parse', '此处需要节点内容', this.#token);
    }

    /**
     * 进入一层集合（深度保护）
     *
     * @param {any} token 位置来源 token
     * @returns {void}
     */
    #enter(token) {
        this.#depth += 1;
        if (this.#depth > this.#options.maxDepth) {
            throw this.#error('parse', `嵌套深度超过 maxDepth（${this.#options.maxDepth}）`, token);
        }
    }

    /**
     * 退出一层集合
     *
     * @returns {void}
     */
    #leave() {
        this.#depth -= 1;
    }

    /**
     * 解析块序列
     *
     * @param {Array<any>} events 事件数组
     * @param {string|null} anchor 锚点
     * @param {{handle: string|null, suffix: string}|null} tag 标签
     * @param {{index: number, line: number, column: number}} start 起始位置
     * @param {boolean} indentless 是否无 BLOCK_SEQUENCE_START
     * @returns {void}
     */
    #parseBlockSequence(events, anchor, tag, start, indentless) {
        this.#enter(this.#token);
        if (!indentless) {
            this.#advance();
        }
        events.push({ type: EVENT.SEQUENCE_START, anchor, tag, flow: false, start });

        for (;;) {
            this.#requireToken('块序列在结束前就遇到了输入结束');

            if (indentless) {
                if (this.#token.type !== TOKEN.BLOCK_ENTRY) {
                    break;
                }
            } else {
                if (this.#token.type === TOKEN.BLOCK_END) {
                    this.#advance();
                    break;
                }
                if (this.#token.type !== TOKEN.BLOCK_ENTRY) {
                    throw this.#error('parse', '块序列里出现了不属于序列的 token', this.#token);
                }
            }

            this.#advance();
            if (this.#token.type === TOKEN.BLOCK_ENTRY || this.#token.type === TOKEN.BLOCK_END) {
                this.#pushEmptyScalar(events, this.#token.start, null, null);
                continue;
            }
            this.#parseNode(events, true, true, null, null);
        }

        events.push({ type: EVENT.SEQUENCE_END, start });
        this.#leave();
    }

    /**
     * 解析块映射
     *
     * @param {Array<any>} events 事件数组
     * @param {string|null} anchor 锚点
     * @param {{handle: string|null, suffix: string}|null} tag 标签
     * @param {{index: number, line: number, column: number}} start 起始位置
     * @returns {void}
     */
    #parseBlockMapping(events, anchor, tag, start) {
        this.#enter(this.#token);
        this.#advance();
        events.push({ type: EVENT.MAPPING_START, anchor, tag, flow: false, start });

        for (;;) {
            this.#requireToken('块映射在结束前就遇到了输入结束');

            if (this.#token.type === TOKEN.BLOCK_END) {
                this.#advance();
                break;
            }
            if (this.#token.type !== TOKEN.KEY) {
                throw this.#error('parse', '块映射里出现了不属于映射的 token', this.#token);
            }

            this.#advance();
            if (this.#isBlockKeyEnd()) {
                this.#pushEmptyScalar(events, this.#token.start, null, null);
            } else {
                this.#parseNode(events, true, true, null, null);
            }

            this.#requireToken('块映射的键之后缺少值');
            if (this.#token.type === TOKEN.VALUE) {
                this.#advance();
                if (this.#isBlockKeyEnd()) {
                    this.#pushEmptyScalar(events, this.#token.start, null, null);
                } else {
                    this.#parseNode(events, true, true, null, null);
                }
            } else {
                this.#pushEmptyScalar(events, this.#token.start, null, null);
            }
        }

        events.push({ type: EVENT.MAPPING_END, start });
        this.#leave();
    }

    /**
     * 块映射的键 / 值是否为空节点
     *
     * @returns {boolean} 为空返回 true
     */
    #isBlockKeyEnd() {
        return this.#token.type === TOKEN.KEY
            || this.#token.type === TOKEN.VALUE
            || this.#token.type === TOKEN.BLOCK_END;
    }

    /**
     * 解析流式序列
     *
     * @param {Array<any>} events 事件数组
     * @param {string|null} anchor 锚点
     * @param {{handle: string|null, suffix: string}|null} tag 标签
     * @param {{index: number, line: number, column: number}} start 起始位置
     * @returns {void}
     */
    #parseFlowSequence(events, anchor, tag, start) {
        this.#enter(this.#token);
        this.#advance();
        events.push({ type: EVENT.SEQUENCE_START, anchor, tag, flow: true, start });

        let first = true;
        for (;;) {
            this.#requireToken('流式序列在结束前就遇到了输入结束');

            const token = this.#token;
            if (token.type === TOKEN.FLOW_SEQUENCE_END) {
                this.#advance();
                break;
            }

            if (!first) {
                if (token.type !== TOKEN.FLOW_ENTRY) {
                    throw this.#error('parse', '流式序列的条目之间缺少 ","', token);
                }
                this.#advance();
                this.#requireToken('流式序列在结束前就遇到了输入结束');
                if (this.#token.type === TOKEN.FLOW_SEQUENCE_END) {
                    this.#advance();
                    break;
                }
            }
            first = false;

            if (this.#token.type === TOKEN.KEY) {
                // 流式序列里的"单键映射"：`[a: b]` 等价于 `[{a: b}]`
                this.#enter(this.#token);
                this.#advance();
                events.push({ type: EVENT.MAPPING_START, anchor: null, tag: null, flow: true, start });
                if (this.#isFlowPairEnd()) {
                    this.#pushEmptyScalar(events, this.#token.start, null, null);
                } else {
                    this.#parseNode(events, false, false, null, null);
                }
                this.#requireToken('流式序列的单键映射缺少值');
                if (this.#token.type === TOKEN.VALUE) {
                    this.#advance();
                    if (this.#isFlowPairEnd()) {
                        this.#pushEmptyScalar(events, this.#token.start, null, null);
                    } else {
                        this.#parseNode(events, false, false, null, null);
                    }
                } else {
                    this.#pushEmptyScalar(events, this.#token.start, null, null);
                }
                events.push({ type: EVENT.MAPPING_END, start });
                this.#leave();
                continue;
            }

            if (this.#token.type === TOKEN.FLOW_ENTRY || this.#token.type === TOKEN.VALUE) {
                this.#pushEmptyScalar(events, this.#token.start, null, null);
                continue;
            }

            this.#parseNode(events, false, false, null, null);
        }

        events.push({ type: EVENT.SEQUENCE_END, start });
        this.#leave();
    }

    /**
     * 流式单键映射的键 / 值是否为空节点
     *
     * @returns {boolean} 为空返回 true
     */
    #isFlowPairEnd() {
        return this.#token.type === TOKEN.VALUE
            || this.#token.type === TOKEN.FLOW_ENTRY
            || this.#token.type === TOKEN.FLOW_SEQUENCE_END
            || this.#token.type === TOKEN.FLOW_MAPPING_END;
    }

    /**
     * 解析流式映射
     *
     * @param {Array<any>} events 事件数组
     * @param {string|null} anchor 锚点
     * @param {{handle: string|null, suffix: string}|null} tag 标签
     * @param {{index: number, line: number, column: number}} start 起始位置
     * @returns {void}
     */
    #parseFlowMapping(events, anchor, tag, start) {
        this.#enter(this.#token);
        this.#advance();
        events.push({ type: EVENT.MAPPING_START, anchor, tag, flow: true, start });

        let first = true;
        for (;;) {
            this.#requireToken('流式映射在结束前就遇到了输入结束');

            if (this.#token.type === TOKEN.FLOW_MAPPING_END) {
                this.#advance();
                break;
            }

            if (!first) {
                if (this.#token.type !== TOKEN.FLOW_ENTRY) {
                    throw this.#error('parse', '流式映射的条目之间缺少 ","', this.#token);
                }
                this.#advance();
                this.#requireToken('流式映射在结束前就遇到了输入结束');
                if (this.#token.type === TOKEN.FLOW_MAPPING_END) {
                    this.#advance();
                    break;
                }
            }
            first = false;

            if (this.#token.type === TOKEN.KEY) {
                this.#advance();
                if (this.#isFlowKeyEnd()) {
                    this.#pushEmptyScalar(events, this.#token.start, null, null);
                } else {
                    this.#parseNode(events, false, false, null, null);
                }
            } else if (this.#token.type === TOKEN.VALUE) {
                this.#pushEmptyScalar(events, this.#token.start, null, null);
            } else {
                this.#parseNode(events, false, false, null, null);
            }

            this.#requireToken('流式映射的键之后缺少值');
            if (this.#token.type === TOKEN.VALUE) {
                this.#advance();
                this.#requireToken('流式映射在结束前就遇到了输入结束');
                if (this.#token.type === TOKEN.FLOW_ENTRY
                    || this.#token.type === TOKEN.FLOW_MAPPING_END
                    || this.#token.type === TOKEN.KEY) {
                    this.#pushEmptyScalar(events, this.#token.start, null, null);
                } else {
                    this.#parseNode(events, false, false, null, null);
                }
            } else {
                this.#pushEmptyScalar(events, this.#token.start, null, null);
            }
        }

        events.push({ type: EVENT.MAPPING_END, start });
        this.#leave();
    }

    /**
     * 流式映射的键是否为空节点
     *
     * @returns {boolean} 为空返回 true
     */
    #isFlowKeyEnd() {
        return this.#token.type === TOKEN.VALUE
            || this.#token.type === TOKEN.FLOW_ENTRY
            || this.#token.type === TOKEN.FLOW_MAPPING_END;
    }
}
