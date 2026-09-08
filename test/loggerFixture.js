/**
 * 日志测试夹具：捕获 stdout 与解析结构化日志行
 *
 * 供 logger.test.js / serverLogger.test.js 共用，自身不依赖库目录状态。
 */

/**
 * 解析一行结构化日志：`ISO时间\tLEVEL(定宽)\t消息[\t附加字段JSON]`
 *
 * @param {string} line 原始行
 * @returns {{time: string, level: string, message: string, fields: Record<string, any>}} 解析结果
 */
export function parseLogLine(line) {
    const [time, level, message, ...rest] = line.split('\t');
    return {
        time,
        level: level.trimEnd(),
        message,
        fields: rest.length > 0 ? JSON.parse(rest.join('\t')) : {},
    };
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
    return lines.join('').split('\n').filter((l) => l !== '').map(parseLogLine);
}
