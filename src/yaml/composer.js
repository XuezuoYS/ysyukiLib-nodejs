/**
 * @fileoverview YAML 合成器（event → 节点图）
 *
 * 把 parser 的事件流组装成节点图，并在此完成两件只有"看到全局"才能做的事：
 *
 * 1. **锚点 / 别名**：锚点在解析其子节点**之前**登记，因此 `&a [*a]` 这类自引用（环状结构）
 *    能成立；别名只允许引用**先前**出现过的锚点（前向引用报错）；锚点重定义按"最近定义生效"。
 * 2. **标签解析**：`!!int` / `!foo!bar` / `!<verbatim>` 通过当前文档的 `%TAG` 句柄表展开成完整标签；
 *    未知或本地标签按 `unknownTags` 策略处理（默认报错，绝不尝试构造任意对象）。
 *
 * 标签只在这里定下来，值由 constructor.js 构造——这样"扩成什么类型"与"值怎么造"可以分别测试。
 */

import { YamlError } from './yamlError.js';
import { EVENT } from './parser.js';
import {
    KNOWN_TAGS,
    NON_SPECIFIC_TAG,
    TAG,
    resolvePlainTag,
    resolveTagReference,
} from './schema.js';

/**
 * 依文档声明与调用方选项决定隐式解析表
 *
 * 未显式传 `schema` 时，`%YAML 1.1`（或更早）的文档按 YAML 1.1 解析表处理：
 * 显式声明了老版本的文件，里面出现 `yes` / `12:30` 这类写法应当按 1.1 的类型理解。
 *
 * @param {any} document 文档（parser.documents() 的元素）
 * @param {Readonly<Record<string, any>>} options 解析选项
 * @returns {string} 解析表名称
 */
export function schemaForDocument(document, options) {
    if (options.schemaExplicit) {
        return options.schema;
    }
    const version = document?.version;
    if (version && version.major === 1 && version.minor <= 1) {
        return 'yaml11';
    }
    return options.schema;
}

/**
 * 合成单个文档
 *
 * @param {any} document 文档（parser.documents() 的元素）
 * @param {Readonly<Record<string, any>>} options 解析选项
 * @returns {any} 节点图根节点（空文档为 null）
 */
export function composeDocument(document, options) {
    return new Composer(document, options).compose();
}

/**
 * 节点图合成器
 *
 * 契约摘要：`compose()` 消费整个文档事件流，返回节点图；别名超限、未定义别名、
 * 未知标签等错误统一抛 `YamlError`（kind 为 `compose`）。
 *
 * 常用入口：compose。
 */
class Composer {
    /**
     * @type {Array<any>}
     */
    #events;

    /**
     * @type {number}
     */
    #index = 0;

    /**
     * @type {Map<string, any>}
     */
    #anchors = new Map();

    /**
     * @type {Map<string, string>}
     */
    #tagDirectives;

    /**
     * @type {string}
     */
    #schema;

    /**
     * @type {Readonly<Record<string, any>>}
     */
    #options;

    /**
     * 已解引用的别名次数
     * @type {number}
     */
    #aliasCount = 0;

    /**
     * @param {any} document 文档
     * @param {Readonly<Record<string, any>>} options 解析选项
     */
    constructor(document, options) {
        this.#events = document.events;
        this.#tagDirectives = document.tagDirectives ?? new Map();
        this.#schema = schemaForDocument(document, options);
        this.#options = options;
    }

    /**
     * 合成整个文档
     *
     * @returns {any} 根节点
     */
    compose() {
        const node = this.#nextNode();
        if (this.#index < this.#events.length) {
            throw new YamlError('compose', '文档里有未被消费的节点内容', this.#position(this.#events[this.#index]));
        }
        return node;
    }

    /**
     * 取事件对应的错误位置
     *
     * @param {any} event 事件
     * @returns {{line: number|null, column: number|null, offset: number|null, file: string|null}} 位置
     */
    #position(event) {
        const mark = event?.start;
        return {
            line: mark?.line ?? null,
            column: typeof mark?.column === 'number' ? mark.column + 1 : null,
            offset: mark?.index ?? null,
            file: this.#options.filename,
        };
    }

    /**
     * 消费一个节点事件（含其子事件）
     *
     * @returns {any} 节点
     */
    #nextNode() {
        const event = this.#events[this.#index];
        if (event === undefined) {
            throw new YamlError('compose', '文档在节点结束前就结束了', { file: this.#options.filename });
        }
        this.#index += 1;

        switch (event.type) {
            case EVENT.ALIAS:
                return this.#alias(event);
            case EVENT.SCALAR:
                return this.#scalar(event);
            case EVENT.SEQUENCE_START:
                return this.#sequence(event);
            case EVENT.MAPPING_START:
                return this.#mapping(event);
            default:
                throw new YamlError('compose', '文档结构不完整（集合没有正常闭合）', this.#position(event));
        }
    }

    /**
     * 处理别名事件
     *
     * @param {any} event 事件
     * @returns {any} 别名节点
     */
    #alias(event) {
        this.#aliasCount += 1;
        if (this.#options.maxAliasCount >= 0 && this.#aliasCount > this.#options.maxAliasCount) {
            throw new YamlError('compose', `别名解引用次数超过 maxAliasCount（${this.#options.maxAliasCount}）`, this.#position(event));
        }

        const target = this.#anchors.get(event.anchor);
        if (target === undefined) {
            throw new YamlError('compose', '别名引用了未定义的锚点（别名不能引用后文才出现的锚点）', this.#position(event));
        }
        return {
            kind: 'alias',
            target,
            start: event.start,
            end: event.end,
        };
    }

    /**
     * 处理标量事件
     *
     * @param {any} event 事件
     * @returns {any} 标量节点
     */
    #scalar(event) {
        const explicit = this.#explicitTag(event.tag);
        /** @type {string} */
        let tag;

        if (explicit === NON_SPECIFIC_TAG) {
            // `!` 表示"按节点种类取默认类型"：标量即字符串
            tag = TAG.STR;
        } else if (explicit !== null) {
            tag = explicit;
        } else if (event.style !== '') {
            // 引号 / 块标量永不参与隐式类型推断
            tag = TAG.STR;
        } else {
            tag = event.empty ? TAG.NULL : resolvePlainTag(event.value, this.#schema);
        }

        // 合并键（YAML 1.1 遗留语法）：plain 的 `<<` 在开启 mergeKeys 时标记为 !!merge，
        // 由构造器决定它作为"键"时合并、作为"值"时退化为普通字符串。
        if (tag === TAG.STR && event.style === '' && !event.empty && event.value === '<<' && this.#options.mergeKeys) {
            tag = TAG.MERGE;
        }

        const node = {
            kind: 'scalar',
            value: event.value,
            tag,
            style: event.style,
            anchor: event.anchor,
            start: event.start,
            end: event.end,
        };
        // 标量锚点也要登记：`a: &x 1` / `b: *x` 是合法且常见的写法
        this.#register(event.anchor, node);
        return node;
    }

    /**
     * 处理序列开始事件
     *
     * @param {any} event 事件
     * @returns {any} 序列节点
     */
    #sequence(event) {
        const node = {
            kind: 'sequence',
            tag: this.#collectionTag(event, TAG.SEQ),
            anchor: event.anchor,
            items: [],
            flow: event.flow === true,
            start: event.start,
            end: event.end,
        };
        this.#register(event.anchor, node);

        for (;;) {
            const next = this.#events[this.#index];
            if (next === undefined) {
                throw new YamlError('compose', '序列没有正常闭合', this.#position(event));
            }
            if (next.type === EVENT.SEQUENCE_END) {
                this.#index += 1;
                break;
            }
            node.items.push(this.#nextNode());
        }

        return node;
    }

    /**
     * 处理映射开始事件
     *
     * @param {any} event 事件
     * @returns {any} 映射节点
     */
    #mapping(event) {
        const node = {
            kind: 'mapping',
            tag: this.#collectionTag(event, TAG.MAP),
            anchor: event.anchor,
            entries: [],
            flow: event.flow === true,
            start: event.start,
            end: event.end,
        };
        this.#register(event.anchor, node);

        for (;;) {
            const next = this.#events[this.#index];
            if (next === undefined) {
                throw new YamlError('compose', '映射没有正常闭合', this.#position(event));
            }
            if (next.type === EVENT.MAPPING_END) {
                this.#index += 1;
                break;
            }
            const key = this.#nextNode();
            const value = this.#nextNode();
            node.entries.push({ key, value });
        }

        return node;
    }

    /**
     * 登记锚点
     *
     * 先登记后解析子节点，自引用才能成立；同名锚点重定义按"最近定义生效"。
     *
     * @param {string|null} anchor 锚点名
     * @param {any} node 节点
     * @returns {void}
     */
    #register(anchor, node) {
        if (typeof anchor === 'string' && anchor !== '') {
            this.#anchors.set(anchor, node);
        }
    }

    /**
     * 集合节点的标签
     *
     * @param {any} event 事件
     * @param {string} fallback 默认标签
     * @returns {string} 标签
     */
    #collectionTag(event, fallback) {
        const explicit = this.#explicitTag(event.tag);
        if (explicit === null || explicit === NON_SPECIFIC_TAG) {
            // 无标签与 `!` 非特定标签都按节点种类取默认标签
            return fallback;
        }
        return explicit;
    }

    /**
     * 展开并校验显式标签
     *
     * @param {{handle: string|null, suffix: string}|null} tag 标签引用
     * @returns {string|null} 完整标签；非特定 `!` 返回 NON_SPECIFIC_TAG；无标签或按策略忽略时返回 null
     */
    #explicitTag(tag) {
        if (tag === null || tag === undefined) {
            return null;
        }

        const full = resolveTagReference(tag.handle, tag.suffix, this.#tagDirectives);
        if (full === NON_SPECIFIC_TAG) {
            return NON_SPECIFIC_TAG;
        }
        if (KNOWN_TAGS.has(full)) {
            return full;
        }
        if (this.#options.unknownTags === 'ignore') {
            return null;
        }
        throw new YamlError('compose', '文档里出现了本库不支持的显式标签（未知标签或本地标签）', {
            file: this.#options.filename,
        });
    }
}
