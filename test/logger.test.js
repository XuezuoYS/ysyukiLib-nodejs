import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Logger } from '#YukiLib/logger';
import { Config } from '#YukiLib/config';

/**
 * 测试基座：宿主根与日志目录重定向到临时目录；dev 在场文件由夹具控制（不依赖库目录状态）
 */
const dir = mkdtempSync(join(tmpdir(), 'ysyuki-logger-'));
const devFixture = join(dir, 'dev.config.json');
writeFileSync(devFixture, '{}', 'utf8');
Config.setRootDir(dir);
Config.devConfigFile = devFixture;
Logger.logDir = join(dir, 'logs');

after(() => {
    Logger.logDir = null;
    Config.setRootDir(null);
    rmSync(dir, { recursive: true, force: true });
});

/**
 * 解析一行结构化日志：`ISO时间\tLEVEL(定宽)\t消息[\t附加字段JSON]`
 * @param {string} line 原始行
 * @returns {{time: string, level: string, message: string, fields: Record<string, any>}} 解析结果
 */
function parseLogLine(line) {
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
 * @param {() => void} fn 执行体
 * @returns {{time: string, level: string, message: string, fields: Record<string, any>}[]} 解析后的日志条目
 */
function captureStdout(fn) {
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

describe('Logger', () => {
    it('info 输出标准三段：时间/定宽级别/消息+字段段', () => {
        const entries = captureStdout(() => Logger.info('服务已启动', { port: 8000 }));
        assert.equal(entries.length, 1);
        const entry = entries[0];
        assert.equal(entry.level, 'INFO');
        assert.equal(entry.message, '服务已启动');
        assert.equal(entry.fields.port, 8000);
        assert.ok(!Number.isNaN(Date.parse(entry.time)));
        assert.match(entry.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    });

    it('warn/error 级别字段正确（大写定宽）', () => {
        const entries = captureStdout(() => {
            Logger.warn('警告一');
            Logger.error('错误一');
        });
        assert.deepEqual(entries.map((e) => e.level), ['WARN', 'ERROR']);
        assert.deepEqual(entries.map((e) => e.fields), [{}, {}]);
    });

    it('fields 中的 Error 序列化为 {message, stack}，堆栈只进日志', () => {
        const err = new Error('底层失败');
        const entries = captureStdout(() => Logger.error('操作失败', { err }));
        assert.equal(entries[0].fields.err.message, '底层失败');
        assert.ok(entries[0].fields.err.stack.includes('Error: 底层失败'));
    });

    it('logDir：默认为宿主根下 log/，可显式重定向', () => {
        const current = Logger.logDir;
        Logger.logDir = null;
        assert.equal(Logger.logDir, Config.resolveFromRoot('log'));
        Logger.logDir = current;
        assert.equal(Logger.logDir, current);
    });

    it('消息中的制表符/换行被替换为空格，不破坏行结构', () => {
        const entries = captureStdout(() => Logger.info('a\tb\nc\rd'));
        assert.equal(entries.length, 1);
        assert.equal(entries[0].level, 'INFO');
        assert.equal(entries[0].message, 'a b c d');
    });

    it('cleanup：日志目录不存在时静默返回（公开方法可安全手动调用）', () => {
        const current = Logger.logDir;
        Logger.logDir = join(dir, 'no-such-logdir');
        try {
            assert.doesNotThrow(() => Logger.cleanup());
        } finally {
            Logger.logDir = current;
        }
    });
});

describe('Logger 文件落盘与滚动', () => {
    /** @type {() => Date} 保存的真实时钟 */
    const realNow = Logger.now;

    /**
     * 在指定虚拟日期下执行日志写入
     * @param {string} dateIso 虚拟日期（如 '2026-03-05T10:00:00'）
     * @param {() => void} fn 执行体
     */
    function atDate(dateIso, fn) {
        Logger.now = () => new Date(dateIso);
        try {
            captureStdout(fn);
        } finally {
            Logger.now = realNow;
        }
    }

    it('目录缺失自动创建；文件命名 app-YYYY-MM-DD.log；逐行 JSON', () => {
        Logger.logDir = join(dir, 'freshlogs');
        assert.ok(!existsSync(Logger.logDir));
        atDate('2026-03-05T10:00:00', () => {
            Logger.info('第一条');
            Logger.warn('第二条');
        });
        const file = join(Logger.logDir, 'app-2026-03-05.log');
        assert.ok(existsSync(file));
        const lines = readFileSync(file, 'utf8').trim().split('\n').map(parseLogLine);
        assert.deepEqual(lines.map((e) => e.message), ['第一条', '第二条']);
        assert.deepEqual(lines.map((e) => e.level), ['INFO', 'WARN']);
    });

    it('非开发环境仅 warn/error（stdout 与文件同门控）', () => {
        Logger.logDir = join(dir, 'gate');
        rmSync(devFixture, { force: true }); // isDev() → false
        try {
            /** @type {Record<string, any>[]} */
            let entries = [];
            atDate('2026-03-06T10:00:00', () => {
                entries = captureStdout(() => {
                    Logger.info('应被丢弃');
                    Logger.warn('警告留存');
                    Logger.error('错误留存');
                });
            });
            assert.deepEqual(entries.map((e) => e.level), ['WARN', 'ERROR']);
            const fileText = readFileSync(join(Logger.logDir, 'app-2026-03-06.log'), 'utf8');
            assert.ok(!fileText.includes('应被丢弃'));
            assert.ok(fileText.includes('警告留存'));
            assert.ok(fileText.includes('错误留存'));
        } finally {
            writeFileSync(devFixture, '{}', 'utf8'); // 恢复 dev 在场
        }
    });

    it('跨日滚动触发清理：日期文件仅保留最近 3 个', () => {
        Logger.logDir = join(dir, 'logs2');
        atDate('2026-03-10T10:00:00', () => Logger.warn('D10'));
        writeFileSync(join(Logger.logDir, 'app-2026-03-04.log'), '', 'utf8');
        writeFileSync(join(Logger.logDir, 'app-2026-03-05.log'), '', 'utf8');
        atDate('2026-03-11T10:00:00', () => Logger.warn('D11'));
        const remain = readdirSync(Logger.logDir).filter((n) => n.startsWith('app-')).sort();
        assert.deepEqual(remain, ['app-2026-03-05.log', 'app-2026-03-10.log', 'app-2026-03-11.log']);
    });

    it('落盘失败静默：不抛错且 stdout 通道正常', () => {
        const blocker = join(dir, 'blocker');
        writeFileSync(blocker, 'x', 'utf8');
        Logger.logDir = join(blocker, 'sub'); // 父路径是文件 → 建目录/追加必失败
        atDate('2026-03-12T10:00:00', () => {
            const entries = captureStdout(() => Logger.error('磁盘不可用'));
            assert.equal(entries.length, 1);
        });
    });
});
