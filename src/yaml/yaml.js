/**
 * @fileoverview YAML 读取 / 写出入口
 *
 * 本文件是"读文件 + 解析 + 构造 + 序列化"的对外门面；解析细节分在 `reader` / `scanner` /
 * `parser` / `composer` / `constructor` / `stringify` 各层，每一层都能被单独测试。
 *
 * 文件读取约定：
 * - 绝对路径原样使用；相对路径经 `Config.resolveFromRoot()` 基于**宿主项目根**解析
 *   （与 `.env` / `config.json` 同一套路径规则）；
 * - 只读文件，不写入；文件不存在 / 无权限 / 是 UTF-16 编码时抛 `YamlError`（kind 为 `file`），
 *   消息只带路径与 errno 码，**不带文件内容**（避免密钥进日志）。
 *
 * 错误消息纪律见 yamlError.js：解析失败只报"第几行第几列 + 固定原因"，不报原文片段。
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { Config } from '../config.js';
import { composeDocument } from './composer.js';
import { constructDocument } from './constructor.js';
import { normalizeParseOptions } from './options.js';
import { Parser } from './parser.js';
import { stringifyDocument, stringifyDocuments } from './stringify.js';
import { YamlError } from './yamlError.js';

/**
 * 取异常的"可安全记录标识"
 *
 * 只用 errno `code`（ENOENT / EACCES / EISDIR 等），没有 code 时退化为错误类型名；
 * 刻意不取 `message`——本库承诺错误消息不携带文件内容，而 `message` 恰恰会带路径与系统文案。
 *
 * @param {any} err 捕获到的异常
 * @returns {string} 错误码或错误类型名
 */
function errorLabel(err) {
    const code = err !== null && typeof err === 'object' ? /** @type {any} */ (err).code : undefined;
    if (typeof code === 'string' && code !== '') {
        return code;
    }
    return err instanceof Error ? err.name : typeof err;
}

/**
 * 读取 YAML 文件
 *
 * @param {string} file 文件路径（绝对路径原样使用，相对路径基于宿主项目根）
 * @returns {{text: string, file: string}} 文本与绝对路径
 */
function readYamlFile(file) {
    if (typeof file !== 'string' || file === '') {
        throw new TypeError('YAML 文件路径必须是非空字符串');
    }

    const absolute = isAbsolute(file) ? resolve(file) : Config.resolveFromRoot(file);

    /** @type {Buffer} */
    let buffer;
    try {
        buffer = readFileSync(absolute);
    } catch (err) {
        throw new YamlError('file', `无法读取文件（${errorLabel(err)}）`, { file: absolute });
    }

    if (buffer.length >= 2
        && ((buffer[0] === 0xFF && buffer[1] === 0xFE) || (buffer[0] === 0xFE && buffer[1] === 0xFF))) {
        throw new YamlError('file', '文件是 UTF-16 编码，本库不支持；请转存为 UTF-8（可带 BOM）', { file: absolute });
    }

    return { text: buffer.toString('utf8'), file: absolute };
}

/**
 * 解析文本为文档列表
 *
 * @param {string} text 输入文本
 * @param {Readonly<Record<string, any>>} options 已归一化的解析选项
 * @returns {Array<any>} 文档列表
 */
function parseDocuments(text, options) {
    return new Parser(text, options).documents();
}

/**
 * YAML 1.2 读取 / 写出
 *
 * 契约摘要：解析失败与文件错误统一抛 `YamlError`（带 `kind` 与行列定位，消息不含原文片段）；
 * 选项非法抛 `TypeError`；`stringify` 的输出可被 `parse` 回等价值。
 *
 * 完整约定（支持的语法、四张隐式类型表、选项表、安全限额、round-trip 例外清单）
 * 见 [docs/yaml.md](../../docs/yaml.md) 与 README。
 *
 * 常用入口：
 * - parse / parseAll：解析文本
 * - parseFile / parseFileAll：读文件并解析（相对路径基于宿主项目根）
 * - stringify / stringifyAll：序列化
 */
export class Yaml {
    /**
     * 解析单个文档
     *
     * 空输入（空串 / 只有注释）返回 `null`；输入包含多个文档时抛错，请改用 `parseAll`。
     *
     * @default options = {}
     * @param {string} text YAML 文本
     * @param {Record<string, any>} [options] 解析选项
     * @returns {any} 解析结果
     */
    static parse(text, options = {}) {
        const normalized = normalizeParseOptions(options);
        const documents = parseDocuments(text, normalized);
        if (documents.length === 0) {
            return null;
        }
        if (documents.length > 1) {
            throw new YamlError('parse', '输入包含多个文档，请改用 Yaml.parseAll', { file: normalized.filename });
        }
        return constructDocument(composeDocument(documents[0], normalized), normalized);
    }

    /**
     * 解析全部文档
     *
     * @default options = {}
     * @param {string} text YAML 文本
     * @param {Record<string, any>} [options] 解析选项
     * @returns {Array<any>} 文档结果数组（空输入为空数组）
     */
    static parseAll(text, options = {}) {
        const normalized = normalizeParseOptions(options);
        return parseDocuments(text, normalized)
            .map((document) => constructDocument(composeDocument(document, normalized), normalized));
    }

    /**
     * 读取文件并解析单个文档
     *
     * @default options = {}
     * @param {string} file 文件路径（相对路径基于宿主项目根）
     * @param {Record<string, any>} [options] 解析选项
     * @returns {any} 解析结果
     */
    static parseFile(file, options = {}) {
        const { text, file: absolute } = readYamlFile(file);
        return Yaml.parse(text, { ...options, filename: absolute });
    }

    /**
     * 读取文件并解析全部文档
     *
     * @default options = {}
     * @param {string} file 文件路径（相对路径基于宿主项目根）
     * @param {Record<string, any>} [options] 解析选项
     * @returns {Array<any>} 文档结果数组
     */
    static parseFileAll(file, options = {}) {
        const { text, file: absolute } = readYamlFile(file);
        return Yaml.parseAll(text, { ...options, filename: absolute });
    }

    /**
     * 序列化为 YAML 文本
     *
     * @default options = {}
     * @param {any} value 要写出的值
     * @param {Record<string, any>} [options] 序列化选项
     * @returns {string} YAML 文本（恒以 `\n` 结尾）
     */
    static stringify(value, options = {}) {
        return stringifyDocument(value, options);
    }

    /**
     * 序列化为多文档 YAML 文本（每个文档以 `---` 开头）
     *
     * @default options = {}
     * @param {Array<any>} values 值数组
     * @param {Record<string, any>} [options] 序列化选项
     * @returns {string} YAML 多文档文本
     */
    static stringifyAll(values, options = {}) {
        return stringifyDocuments(values, options);
    }
}
