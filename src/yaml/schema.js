/**
 * @fileoverview YAML 标签与类型推断
 *
 * 两件事：
 * 1. **隐式解析**（`resolvePlainTag`）：只有 plain 标量参与类型推断，引号标量与块标量恒为字符串；
 *    四张表对应规范的 failsafe / JSON / core schema，外加一个 `yaml11` 兼容档
 *    （yes/no/on/off、0NNN 八进制、0b 二进制、下划线数字、时间戳）。
 * 2. **显式标签构造**（`constructScalarValue`）：`!!int` / `!!float` / `!!binary` / `!!timestamp` …
 *    只映射到内建 JS 类型，**绝不构造任意对象或执行代码**；未知标签由调用方按策略处理。
 *
 * 同一个 `resolvePlainTag` 也被 stringify.js 复用：判断"这个字符串照原样写出会不会被解析成
 * 别的类型"，从而决定是否加引号——判定只有一个真值来源，round-trip 才不会自相矛盾。
 */

import { YamlError } from './yamlError.js';

/**
 * 标准标签（YAML 1.2 type repository）
 * @type {Readonly<Record<string, string>>}
 */
export const TAG = Object.freeze({
    NULL: 'tag:yaml.org,2002:null',
    BOOL: 'tag:yaml.org,2002:bool',
    INT: 'tag:yaml.org,2002:int',
    FLOAT: 'tag:yaml.org,2002:float',
    STR: 'tag:yaml.org,2002:str',
    BINARY: 'tag:yaml.org,2002:binary',
    TIMESTAMP: 'tag:yaml.org,2002:timestamp',
    OMAP: 'tag:yaml.org,2002:omap',
    PAIRS: 'tag:yaml.org,2002:pairs',
    SET: 'tag:yaml.org,2002:set',
    MAP: 'tag:yaml.org,2002:map',
    SEQ: 'tag:yaml.org,2002:seq',
    MERGE: 'tag:yaml.org,2002:merge',
});

/**
 * 已知标签集合（未知标签走 unknownTags 策略）
 * @type {ReadonlySet<string>}
 */
export const KNOWN_TAGS = Object.freeze(new Set(Object.values(TAG)));

/**
 * 非特定标签 `!` 的标记（"按节点种类取默认类型"）
 * @type {string}
 */
export const NON_SPECIFIC_TAG = '!';

const NULL_PATTERN = /^(?:~|null|Null|NULL)$/;
const CORE_TRUE_PATTERN = /^(?:true|True|TRUE)$/;
const CORE_FALSE_PATTERN = /^(?:false|False|FALSE)$/;
const YAML11_TRUE_PATTERN = /^(?:true|True|TRUE|yes|Yes|YES|on|On|ON)$/;
const YAML11_FALSE_PATTERN = /^(?:false|False|FALSE|no|No|NO|off|Off|OFF)$/;

const CORE_INT_PATTERN = /^[-+]?[0-9]+$/;
const CORE_OCT_INT_PATTERN = /^[-+]?0o[0-7]+$/;
const CORE_HEX_INT_PATTERN = /^[-+]?0x[0-9a-fA-F]+$/;
const YAML11_OCT_INT_PATTERN = /^[-+]?0[0-7_]+$/;
const YAML11_BIN_INT_PATTERN = /^[-+]?0b[01_]+$/;
const YAML11_DEC_INT_PATTERN = /^[-+]?[0-9](?:_?[0-9])*$/;
const YAML11_SEXA_INT_PATTERN = /^[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+$/;

const JSON_INT_PATTERN = /^-?(?:0|[1-9][0-9]*)$/;

const CORE_FLOAT_PATTERN = /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/;
const CORE_INF_PATTERN = /^[-+]?\.(?:inf|Inf|INF)$/;
const CORE_NAN_PATTERN = /^\.(?:nan|NaN|NAN)$/;
const YAML11_FLOAT_PATTERN = /^[-+]?(?:\.[0-9_]+|[0-9][0-9_]*(?:\.[0-9_]*)?)(?:[eE][-+]?[0-9]+)?$/;
const YAML11_SEXA_FLOAT_PATTERN = /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/;

const JSON_FLOAT_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$/;

const DATE_ONLY_PATTERN = /^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})$/;
const TIMESTAMP_PATTERN = /^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:[Tt]|[ \t]+)([0-9]{1,2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]*))?(?:[ \t]*(Z|([-+])([0-9]{1,2})(?::?([0-9]{2}))?))?$/;

/**
 * 去掉 YAML 1.1 风格的下划线分隔符
 *
 * @param {string} text 文本
 * @returns {string} 去掉下划线的文本
 */
function stripUnderscores(text) {
    return text.replace(/_/g, '');
}

/**
 * 判断 plain 标量在给定解析表下的隐式标签
 *
 * @param {string} text plain 标量文本
 * @param {string} schema 解析表名称
 * @returns {string} 隐式标签（TAG.* 之一）
 */
export function resolvePlainTag(text, schema) {
    if (schema === 'failsafe') {
        return TAG.STR;
    }
    if (text === '') {
        // 空节点：除 failsafe 外一律解析成 null
        return TAG.NULL;
    }

    if (schema === 'json') {
        if (text === 'null') {
            return TAG.NULL;
        }
        if (text === 'true' || text === 'false') {
            return TAG.BOOL;
        }
        if (JSON_INT_PATTERN.test(text)) {
            return TAG.INT;
        }
        if (JSON_FLOAT_PATTERN.test(text) && /[.eE]/.test(text)) {
            return TAG.FLOAT;
        }
        return TAG.STR;
    }

    if (schema === 'yaml11') {
        if (NULL_PATTERN.test(text)) {
            return TAG.NULL;
        }
        if (YAML11_TRUE_PATTERN.test(text) || YAML11_FALSE_PATTERN.test(text)) {
            return TAG.BOOL;
        }
        if (CORE_HEX_INT_PATTERN.test(text) || YAML11_OCT_INT_PATTERN.test(text)
            || YAML11_BIN_INT_PATTERN.test(text) || YAML11_SEXA_INT_PATTERN.test(text)
            || CORE_INT_PATTERN.test(text) || YAML11_DEC_INT_PATTERN.test(text)) {
            return TAG.INT;
        }
        if (CORE_INF_PATTERN.test(text) || CORE_NAN_PATTERN.test(text)
            || YAML11_SEXA_FLOAT_PATTERN.test(text)
            || (CORE_FLOAT_PATTERN.test(text) && /[.eE]/.test(text))
            || (YAML11_FLOAT_PATTERN.test(text) && /[.eE]/.test(text))) {
            return TAG.FLOAT;
        }
        if (parseTimestamp(text) !== null) {
            return TAG.TIMESTAMP;
        }
        return TAG.STR;
    }

    // core（默认）
    if (NULL_PATTERN.test(text)) {
        return TAG.NULL;
    }
    if (CORE_TRUE_PATTERN.test(text) || CORE_FALSE_PATTERN.test(text)) {
        return TAG.BOOL;
    }
    if (CORE_INT_PATTERN.test(text) || CORE_OCT_INT_PATTERN.test(text) || CORE_HEX_INT_PATTERN.test(text)) {
        return TAG.INT;
    }
    if (CORE_INF_PATTERN.test(text) || CORE_NAN_PATTERN.test(text)
        || (CORE_FLOAT_PATTERN.test(text) && /[.eE]/.test(text))) {
        return TAG.FLOAT;
    }
    return TAG.STR;
}

/**
 * 判断字符串照 plain 样式写出后是否会被隐式解析成非字符串
 *
 * @param {string} text 字符串
 * @param {string} schema 解析表名称
 * @returns {boolean} 会被解析成非字符串返回 true
 */
export function wouldResolveAsNonString(text, schema) {
    return resolvePlainTag(text, schema) !== TAG.STR;
}

/**
 * 解析标签引用为完整标签
 *
 * @param {string|null} handle 句柄（verbatim 标签为 null）
 * @param {string} suffix 后缀（verbatim 标签时即完整标签）
 * @param {Map<string, string>|null} tagDirectives 当前文档的 `%TAG` 句柄表
 * @returns {string} 完整标签，或 NON_SPECIFIC_TAG（`!`）
 */
export function resolveTagReference(handle, suffix, tagDirectives) {
    if (handle === null) {
        return suffix;
    }
    if (handle === '!' && suffix === '') {
        return NON_SPECIFIC_TAG;
    }
    const prefix = tagDirectives?.get(handle) ?? (handle === '!!' ? 'tag:yaml.org,2002:' : '!');
    return prefix + suffix;
}

/**
 * 解析时间戳
 *
 * 未匹配返回 null。带时区（`Z` / `±HH[:MM]`）时按绝对时刻构造；
 * 只有日期时按 UTC 零点；带时间但无时区时按**本地时间**（与常见 YAML 实现一致）。
 *
 * @param {string} text 文本
 * @returns {Date|null} 时间对象，未匹配返回 null
 */
export function parseTimestamp(text) {
    const dateOnly = DATE_ONLY_PATTERN.exec(text);
    if (dateOnly !== null) {
        const [, year, month, day] = dateOnly;
        if (!isValidDateParts(Number(year), Number(month), Number(day))) {
            return null;
        }
        return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    }

    const match = TIMESTAMP_PATTERN.exec(text);
    if (match === null) {
        return null;
    }
    const [, year, month, day, hour, minute, second, fraction, zone, sign, zoneHour, zoneMinute] = match;
    if (!isValidDateParts(Number(year), Number(month), Number(day))
        || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 60
        || (zoneHour !== undefined && Number(zoneHour) > 23)
        || (zoneMinute !== undefined && Number(zoneMinute) > 59)) {
        return null;
    }

    const milliseconds = fraction === undefined ? 0 : Number((`${fraction}000`).slice(0, 3));

    if (zone === 'Z') {
        return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), milliseconds));
    }
    if (zone !== undefined && sign !== undefined) {
        const offset = (Number(zoneHour) * 60 + Number(zoneMinute ?? 0)) * 60000;
        const utc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), milliseconds);
        return new Date(sign === '-' ? utc + offset : utc - offset);
    }
    return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), milliseconds);
}

/**
 * 年月日是否真实存在（含闰年与各月天数）
 *
 * 只做范围检查不够：`2020-02-30` 会被 `Date.UTC` 悄悄滚到 3 月 1 日，
 * 于是非法时间戳变成了"看起来合法"的另一个日期。
 *
 * @param {number} year 年
 * @param {number} month 月（1 起）
 * @param {number} day 日
 * @returns {boolean} 合法返回 true
 */
function isValidDateParts(year, month, day) {
    if (!Number.isInteger(month) || month < 1 || month > 12 || day < 1) {
        return false;
    }
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    /** @type {ReadonlyArray<number>} */
    const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return day <= daysInMonth[month - 1];
}

/**
 * 解析整数为 bigint（并做形态校验）
 *
 * 覆盖 core（十进制 / `0o` / `0x`）与 YAML 1.1 遗留（`0NNN` 八进制、`0b` 二进制、下划线、sexagesimal）。
 * 任何不认识的形态都抛 `YamlError`：`BigInt()` 自己会抛 `SyntaxError`，不能让宿主拿到非本库的异常类型。
 *
 * @param {string} text 文本
 * @returns {bigint} 数值
 */
function parseIntBigInt(text) {
    const negative = text.startsWith('-');
    const cleaned = stripUnderscores(text.replace(/^[-+]/, ''));

    /** @type {bigint} */
    let value;
    if (/^0[xX][0-9a-fA-F]+$/.test(cleaned)) {
        value = BigInt(cleaned);
    } else if (/^0[oO][0-7]+$/.test(cleaned)) {
        value = BigInt(cleaned);
    } else if (/^0[bB][01]+$/.test(cleaned)) {
        value = BigInt(cleaned);
    } else if (/^0[0-7]+$/.test(cleaned) && cleaned.length > 1) {
        value = BigInt(`0o${cleaned.slice(1)}`);
    } else if (cleaned.includes(':')) {
        const parts = cleaned.split(':');
        if (!parts.every((part) => /^[0-9]+$/.test(part)) || parts.some((part) => Number(part) > 59)) {
            throw new YamlError('construct', '!!int 的值不是合法整数写法');
        }
        value = parts.reduce((acc, part) => acc * 60n + BigInt(part), 0n);
    } else if (/^[0-9]+$/.test(cleaned)) {
        value = BigInt(cleaned);
    } else {
        throw new YamlError('construct', '!!int 的值不是合法整数写法');
    }

    return negative ? -value : value;
}

/**
 * 解析浮点为 number
 *
 * @param {string} text 文本
 * @returns {number} 数值
 */
function parseFloatValue(text) {
    const cleaned = stripUnderscores(text);
    if (CORE_INF_PATTERN.test(cleaned)) {
        return cleaned.startsWith('-') ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    }
    if (CORE_NAN_PATTERN.test(cleaned)) {
        return Number.NaN;
    }
    if (cleaned.includes(':')) {
        const negative = cleaned.startsWith('-');
        const parts = cleaned.replace(/^[-+]/, '').split(':');
        const seconds = Number(parts.pop());
        const scaled = parts.reduce((acc, part) => acc * 60 + Number(part), 0) * 60 + seconds;
        return negative ? -scaled : scaled;
    }
    return Number(cleaned);
}

/**
 * 构造显式标签 / 隐式标签对应的 JS 值
 *
 * @default options = {}
 * @param {string} text 标量文本（plain 时为原文；引号 / 块标量为已解码的内容）
 * @param {string} tag 标签
 * @param {{intAsBigInt?: boolean}} [options] 构造选项
 * @returns {any} JS 值
 */
export function constructScalarValue(text, tag, options = {}) {
    switch (tag) {
        case TAG.STR:
            return text;
        case TAG.NULL:
            return null;
        case TAG.BOOL:
            if (YAML11_TRUE_PATTERN.test(text)) {
                return true;
            }
            if (YAML11_FALSE_PATTERN.test(text)) {
                return false;
            }
            throw new YamlError('construct', '!!bool 的值不是合法布尔写法');
        case TAG.INT: {
            const value = parseIntBigInt(text);
            if (options.intAsBigInt
                && (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER))) {
                return value;
            }
            return Number(value);
        }
        case TAG.FLOAT:
            return parseFloatValue(text);
        case TAG.BINARY:
            return parseBase64(text);
        case TAG.TIMESTAMP: {
            const date = parseTimestamp(text);
            if (date === null) {
                throw new YamlError('construct', '!!timestamp 的值不是合法时间戳写法');
            }
            return date;
        }
        default:
            throw new YamlError('construct', '内部错误：未知的标量标签');
    }
}

/**
 * 解析 base64（`!!binary`）
 *
 * YAML 的规范形态允许折行与空格，先剔除空白再校验字符集，避免 `Buffer.from` 静默吞掉非法字符。
 *
 * @param {string} text 文本
 * @returns {Buffer} 字节
 */
function parseBase64(text) {
    const cleaned = text.replace(/\s+/g, '');
    if (cleaned === '') {
        return Buffer.alloc(0);
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) {
        throw new YamlError('construct', '!!binary 的值不是合法 base64');
    }
    return Buffer.from(cleaned, 'base64');
}
