/**
 * 日志测试夹具：捕获 stdout 与解析结构化日志行
 *
 * 供 logger.test.js / serverLogger.test.js / server.test.js 共用，自身不依赖库目录状态。
 */

/**
 * 本库日志行前缀：ISO 本地时间戳 + 制表符 + 大写定宽等级 + 制表符
 *
 * 捕获期间只吞掉这种行，其余 stdout 输出（如 `node --test` 运行器自己的用例结果）
 * 原样转发——整段拦截会把运行器的输出一并吞掉，导致丢用例结果、suite 错挂（假 ✖）。
 * @type {RegExp}
 */
const LOG_LINE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}\t[A-Z]{3,5} *\t/;

/**
 * 解析一行结构化日志：`ISO时间\tLEVEL(定宽)\t消息[\t附加字段JSON]`
 *
 * 非日志行（无制表符分隔，如并发写入 stdout 的其它输出）返回 null，由调用方过滤，
 * 避免夹具在遇到意外输出时抛 TypeError 掩盖真实断言。
 *
 * @param {string} line 原始行
 * @returns {{time: string, level: string, message: string, fields: Record<string, any>}|null} 解析结果
 */
export function parseLogLine(line) {
    const [time, level, message, ...rest] = line.split('\t');
    if (time === undefined || level === undefined || message === undefined) {
        return null;
    }
    return {
        time,
        level: level.trimEnd(),
        message,
        fields: rest.length > 0 ? JSON.parse(rest.join('\t')) : {},
    };
}

/**
 * 解析多行输出为日志条目，丢弃非日志行
 *
 * @param {string} text 原始输出
 * @returns {{time: string, level: string, message: string, fields: Record<string, any>}[]} 日志条目
 */
export function parseLogLines(text) {
    /** @type {{time: string, level: string, message: string, fields: Record<string, any>}[]} */
    const entries = [];
    for (const line of text.split('\n')) {
        if (line === '') {
            continue;
        }
        const entry = parseLogLine(line);
        if (entry !== null) {
            entries.push(entry);
        }
    }
    return entries;
}

/**
 * 捕获一次函数执行期间写入 stdout 的日志行
 *
 * @param {() => void} fn 执行体
 * @returns {{time: string, level: string, message: string, fields: Record<string, any>}[]} 解析后的日志条目
 */
export function captureStdout(fn) {
    /** @type {string[]} */
    const lines = [];
    const original = process.stdout.write;
    process.stdout.write = makeCapture(lines, original);
    try {
        fn();
    } finally {
        process.stdout.write = original;
    }
    return parseLogLines(lines.join(''));
}

/**
 * 捕获一次异步函数执行期间写入 stdout 的日志行
 *
 * 与 captureStdout 同语义，供需要 await（真实 HTTP 请求等）的用例使用。
 *
 * @param {() => Promise<any>} fn 执行体
 * @returns {Promise<{time: string, level: string, message: string, fields: Record<string, any>}[]>} 解析后的日志条目
 */
export async function captureStdoutAsync(fn) {
    /** @type {string[]} */
    const lines = [];
    const original = process.stdout.write;
    process.stdout.write = makeCapture(lines, original);
    try {
        await fn();
    } finally {
        process.stdout.write = original;
    }
    return parseLogLines(lines.join(''));
}

/**
 * 构造 stdout 写替身：本库日志行收集到 lines，其余原样转发
 *
 * @param {string[]} lines 日志行收集数组
 * @param {typeof process.stdout.write} original 原始 write
 * @returns {typeof process.stdout.write} 替身 write
 */
function makeCapture(lines, original) {
    /** @type {any} */
    const patched = (chunk, ...args) => {
        const text = String(chunk);
        if (LOG_LINE_PATTERN.test(text)) {
            lines.push(text);
            return true;
        }
        return original.call(process.stdout, chunk, ...args);
    };
    return patched;
}
