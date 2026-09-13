/**
 * @fileoverview YAML 字符流读取器
 *
 * 扫描器只通过本类接触输入文本，负责三件事：
 * 1. **归一**：剔除流首 UTF-8 BOM；把 `\r\n` / `\r` / NEL / LS / PS 统一成 `\n`
 *    （规范里标量内容中的换行本身就要归一成 LF，提前归一让上层只需处理一种换行）；
 * 2. **校验**：按规范的 c-printable 集合检查每个码位，非法控制字符与孤立代理项在读取阶段就报错；
 * 3. **定位**：维护 `index`（0 起）、`line`（1 起）、`column`（**0 起**，按 UTF-16 码元计，
 *    与 `index` 同步；对外错误里再 +1 转成 1 起）。
 *
 * 位置按**归一化后**的文本计：CRLF 视为单个换行，故 `offset` 与原始字节偏移在有 CRLF 时不同。
 */

import { YamlError } from './yamlError.js';

/**
 * 判断码位是否属于 c-printable
 *
 * @param {number} codePoint 码位
 * @returns {boolean} 可打印返回 true
 */
function isPrintable(codePoint) {
    return codePoint === 0x09
        || codePoint === 0x0A
        || (codePoint >= 0x20 && codePoint <= 0x7E)
        || codePoint === 0x85
        || (codePoint >= 0xA0 && codePoint <= 0xD7FF)
        || (codePoint >= 0xE000 && codePoint <= 0xFFFD)
        || (codePoint >= 0x10000 && codePoint <= 0x10FFFF);
}

/**
 * 归一化输入文本
 *
 * @param {string} text 原始文本
 * @returns {string} 去 BOM、换行归一后的文本
 */
function normalize(text) {
    const withoutBom = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
    return withoutBom.replace(/\r\n|[\r\u0085\u2028\u2029]/g, '\n');
}

/**
 * 校验可打印字符并返回首个非法码位的位置
 *
 * @param {string} text 归一化后的文本
 * @returns {{line: number, column: number, offset: number}|null} 非法位置，全部合法返回 null
 */
function findUnprintable(text) {
    let line = 1;
    let column = 0;
    for (let index = 0; index < text.length;) {
        const codePoint = text.codePointAt(index) ?? 0;
        if (!isPrintable(codePoint)) {
            return { line, column, offset: index };
        }
        const width = codePoint > 0xFFFF ? 2 : 1;
        if (codePoint === 0x0A) {
            line += 1;
            column = 0;
        } else {
            // 列与 index 同步（按 UTF-16 码元算），保证与 forward() 的计数一致
            column += width;
        }
        index += width;
    }
    return null;
}

/**
 * YAML 字符流
 *
 * 契约摘要：全部位置基于归一化文本；`column` 为 0 起；`peek()` 越过流末尾返回空串
 * （扫描器据此判断"行结束或流结束"）。
 *
 * 常用入口：peek / forward / mark / slice / eof。
 */
export class Reader {
    /**
     * @type {string}
     */
    #text;

    /**
     * @type {number}
     */
    #index = 0;

    /**
     * @type {number}
     */
    #line = 1;

    /**
     * @type {number}
     */
    #column = 0;

    /**
     * @param {string} text 输入文本
     */
    constructor(text) {
        if (typeof text !== 'string') {
            throw new TypeError(`YAML 输入必须是字符串，实际为 ${text === null ? 'null' : typeof text}`);
        }

        const normalized = normalize(text);
        const invalid = findUnprintable(normalized);
        if (invalid !== null) {
            throw new YamlError('stream', '包含 YAML 不允许的字符（控制字符或孤立代理项）', {
                line: invalid.line,
                column: invalid.column + 1,
                offset: invalid.offset,
            });
        }

        this.#text = normalized;
    }

    /**
     * 当前字符偏移（0 起，归一化文本）
     * @returns {number} 偏移
     */
    get index() {
        return this.#index;
    }

    /**
     * 当前行号（1 起）
     * @returns {number} 行号
     */
    get line() {
        return this.#line;
    }

    /**
     * 当前列号（0 起）
     * @returns {number} 列号
     */
    get column() {
        return this.#column;
    }

    /**
     * 是否已到流末尾
     * @returns {boolean} 结束返回 true
     */
    eof() {
        return this.#index >= this.#text.length;
    }

    /**
     * 读取当前或后续字符
     *
     * @default offset = 0
     * @param {number} [offset] 相对当前位置的偏移（不改动读取位置）
     * @returns {string} 单个字符（按 UTF-16 码元），越过流末尾返回空串
     */
    peek(offset = 0) {
        const index = this.#index + offset;
        return index >= 0 && index < this.#text.length ? this.#text[index] : '';
    }

    /**
     * 前进若干字符（跨行时更新行列）
     *
     * @default count = 1
     * @param {number} [count] 前进的码元数
     * @returns {void}
     */
    forward(count = 1) {
        for (let step = 0; step < count; step += 1) {
            if (this.#index >= this.#text.length) {
                return;
            }
            const ch = this.#text[this.#index];
            this.#index += 1;
            if (ch === '\n') {
                this.#line += 1;
                this.#column = 0;
            } else {
                this.#column += 1;
            }
        }
    }

    /**
     * 记录当前位置
     *
     * @returns {{index: number, line: number, column: number}} 位置快照
     */
    mark() {
        return { index: this.#index, line: this.#line, column: this.#column };
    }

    /**
     * 截取文本片段（用于锚点名、标签、指令等词法片段）
     *
     * @param {number} start 起始偏移
     * @param {number} end 结束偏移（不含）
     * @returns {string} 片段
     */
    slice(start, end) {
        return this.#text.slice(start, end);
    }
}
