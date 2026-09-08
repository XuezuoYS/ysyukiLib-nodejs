/**
 * 日志测试夹具：捕获 stdout 与解析结构化日志行
 *
 * 供 logger.test.js / serverLogger.test.js / server.test.js 共用，自身不依赖库目录状态。
 */

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
    process.stdout.write = (chunk) => {
        lines.push(String(chunk));
        return true;
    };
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
    process.stdout.write = (chunk) => {
        lines.push(String(chunk));
        return true;
    };
    try {
        await fn();
    } finally {
        process.stdout.write = original;
    }
    return parseLogLines(lines.join(''));
}
