import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Logger, SubLogger } from '#YukiLib/logger';
import { Config } from '#YukiLib/config';

import { captureStdout, parseLogLine } from './loggerFixture.js';

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

describe('Logger：等级阈值与配置隔离', () => {
    it('Logger.create 返回 SubLogger，默认跟随默认等级（dev 在场 → info）', () => {
        const log = Logger.create();
        assert.ok(log instanceof SubLogger);
        assert.equal(log.level, 'info');
        assert.deepEqual(captureStdout(() => log.info('子 logger info')).map((e) => e.level), ['INFO']);
    });

    it('等级为阈值：warn 记 warn+error，info 丢弃', () => {
        const log = Logger.create({ level: 'warn' });
        const entries = captureStdout(() => {
            log.info('丢弃');
            log.warn('留下');
            log.error('也留下');
        });
        assert.deepEqual(entries.map((e) => e.message), ['留下', '也留下']);
        assert.deepEqual(entries.map((e) => e.level), ['WARN', 'ERROR']);
    });

    it('等级为阈值：error 只记 error', () => {
        const log = Logger.create({ level: 'error' });
        const entries = captureStdout(() => {
            log.info('丢弃');
            log.warn('丢弃');
            log.error('留下');
        });
        assert.deepEqual(entries.map((e) => e.message), ['留下']);
    });

    it('配置隔离：多个子 logger 与根 Logger 互不影响', () => {
        const a = Logger.create({ level: 'error' });
        const b = Logger.create({ level: 'info' });
        const entries = captureStdout(() => {
            a.info('a 丢弃');
            b.info('b 留下');
            Logger.info('根留下');
        });
        assert.deepEqual(entries.map((e) => e.message), ['b 留下', '根留下']);
        assert.equal(a.level, 'error');
        assert.equal(b.level, 'info');
    });

    it('等级可后改，且改一个不影响另一个；传 null 恢复跟随默认', () => {
        const a = Logger.create({ level: 'error' });
        const b = Logger.create({ level: 'error' });
        a.level = 'info';
        assert.equal(a.level, 'info');
        assert.equal(b.level, 'error');

        a.level = null;
        assert.equal(a.level, 'info', 'dev 在场时默认等级为 info');
    });

    it('未知等级抛错（构造与赋值均校验）', () => {
        assert.throws(() => Logger.create({ level: /** @type {any} */ ('debug') }), /未知的日志等级/);
        const log = Logger.create();
        assert.throws(() => {
            log.level = /** @type {any} */ ('trace');
        }, /未知的日志等级/);
    });

    it('默认等级跟随 isDev()：失效缓存后同一实例立即切换', () => {
        const log = Logger.create();
        rmSync(devFixture, { force: true });
        Logger.resetDevCache(); // 同一路径上增删文件不会自动失效，须显式重置（见 Logger.defaultLevel 注释）
        try {
            const entries = captureStdout(() => {
                log.info('生产应丢弃');
                log.warn('生产保留');
            });
            assert.deepEqual(entries.map((e) => e.message), ['生产保留']);
        } finally {
            writeFileSync(devFixture, '{}', 'utf8');
        }

        Logger.resetDevCache();
        const restored = captureStdout(() => log.info('恢复 dev 后重新记录'));
        assert.deepEqual(restored.map((e) => e.message), ['恢复 dev 后重新记录']);
    });

    it('defaultLevel 缓存 dev 判定：写日志不再每条同步 stat', () => {
        const realIsDev = Config.isDev;
        let calls = 0;
        Config.isDev = () => {
            calls += 1;
            return realIsDev.call(Config);
        };
        try {
            Logger.resetDevCache();
            captureStdout(() => {
                for (let i = 0; i < 50; i += 1) Logger.info('x');
            });
            assert.equal(calls, 1, '同一开发配置路径只应 stat 一次（而非每条日志一次）');

            Logger.resetDevCache();
            captureStdout(() => Logger.info('y'));
            assert.equal(calls, 2, '显式失效后重新评估');
        } finally {
            Config.isDev = realIsDev;
            Logger.resetDevCache();
        }
    });

    it('setRootDir 与 devConfigFile 变更会主动失效缓存', () => {
        const realIsDev = Config.isDev;
        let calls = 0;
        Config.isDev = () => {
            calls += 1;
            return realIsDev.call(Config);
        };
        try {
            Logger.resetDevCache();
            void Logger.defaultLevel;
            assert.equal(calls, 1);

            Config.setRootDir(dir);
            void Logger.defaultLevel;
            assert.equal(calls, 2, 'setRootDir 应失效缓存');

            Config.devConfigFile = devFixture;
            void Logger.defaultLevel;
            assert.equal(calls, 3, 'devConfigFile 赋值应失效缓存');
        } finally {
            Config.isDev = realIsDev;
            Config.setRootDir(dir);
            Config.devConfigFile = devFixture;
        }
    });

    it('子 logger 与根 Logger 共用文件通道，日期仅由 Logger.now 决定', () => {
        const previousDir = Logger.logDir;
        const realNow = Logger.now;
        Logger.logDir = join(dir, 'shared');
        Logger.now = () => new Date('2026-04-01T09:00:00');
        try {
            captureStdout(() => {
                Logger.warn('根写入');
                Logger.create({ level: 'warn' }).warn('子写入');
            });
        } finally {
            Logger.now = realNow;
        }

        const text = readFileSync(join(Logger.logDir, 'app-2026-04-01.log'), 'utf8');
        const lines = text.trim().split('\n').map(parseLogLine);
        assert.deepEqual(lines.map((e) => e.message), ['根写入', '子写入']);
        assert.ok(lines[0].time.startsWith('2026-04-01T09:00:00'), '时间戳同样来自 Logger.now');
        Logger.logDir = previousDir;
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
        Logger.resetDevCache();
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

describe('Logger 健壮性：字段序列化不抛错，日志必落', () => {
    /** 当日日期（文件通道断言用） */
    const today = (() => {
        const n = new Date();
        const pad = (v) => String(v).padStart(2, '0');
        return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
    })();

    const previousDir = Logger.logDir;

    /**
     * 写一条并返回解析后的字段（stdout 与文件双通道都要有记录）
     *
     * @param {string} name 本用例专用日志目录名
     * @param {string} message 日志消息
     * @param {Record<string, any>} fields 附加字段
     * @returns {{stdout: Record<string, any>, file: Record<string, any>}} 两通道解析出的字段
     */
    function writeAndRead(name, message, fields) {
        Logger.logDir = join(dir, name);
        const entries = captureStdout(() => Logger.error(message, fields));
        assert.equal(entries.length, 1, '异常字段不得让日志整条消失（stdout 通道）');
        const file = join(Logger.logDir, `app-${today}.log`);
        assert.ok(existsSync(file), '异常字段不得让文件通道丢日志');
        const lines = readFileSync(file, 'utf8').trim().split('\n').map(parseLogLine);
        const last = lines[lines.length - 1];
        assert.ok(last !== null, '文件通道最后一行应是可解析的日志行');
        assert.equal(last.message, message);
        return { stdout: entries[0].fields, file: last.fields };
    }

    it('循环引用字段：不抛错，降级为 [Circular] 标记且两通道都落盘', () => {
        const peer = { name: 'p1' };
        peer.self = peer;
        const { stdout } = writeAndRead('robust-circular', '链路异常', { peer });
        assert.equal(stdout.peer.name, 'p1');
        assert.equal(stdout.peer.self, '[Circular]');
    });

    it('BigInt 字段：不抛错，降级为 [BigInt 10] 标记', () => {
        const { stdout, file } = writeAndRead('robust-bigint', '大整数', { n: 10n });
        assert.equal(stdout.n, '[BigInt 10]');
        assert.deepEqual(file, stdout);
    });

    it('抛错的 getter 字段：不抛错，该键降级为 [Getter threw]', () => {
        const fields = {
            ok: 1,
            get bad() {
                throw new Error('属性读取爆炸');
            },
        };
        const { stdout } = writeAndRead('robust-getter', '取值失败', fields);
        assert.equal(stdout.ok, 1);
        assert.equal(stdout.bad, '[Getter threw]');
    });

    it('toJSON 抛错：不抛错，降级为 [ToJSON threw]', () => {
        const bad = {
            toJSON() {
                throw new Error('toJSON 爆炸');
            },
        };
        const { stdout } = writeAndRead('robust-tojson', '自定义序列化失败', { bad });
        assert.equal(stdout.bad, '[ToJSON threw]');
    });

    it('安全编码沿祖先链判环：同层重复引用不被误伤，超深嵌套截断', () => {
        const shared = { id: 7 };
        /** @type {Record<string, any>} */
        const deep = { level: 0 };
        let cursor = deep;
        for (let i = 1; i <= 20; i += 1) {
            cursor.child = { level: i };
            cursor = cursor.child;
        }
        // 含 BigInt → 原生序列化抛错 → 走安全编码器（循环/深度判定的真实入口）
        const { stdout } = writeAndRead('robust-dag', '复杂结构', { a: shared, b: shared, bad: { n: 1n }, deep });
        assert.deepEqual(stdout.a, { id: 7 }, '兄弟引用同一对象不是循环');
        assert.deepEqual(stdout.b, { id: 7 });
        assert.equal(stdout.bad.n, '[BigInt 1]');
        assert.ok(JSON.stringify(stdout.deep).includes('[Truncated]'), '超过 MAX_FIELD_DEPTH 应截断');
    });

    it('消息不可转文本：不抛错，仍留下一行', () => {
        const nasty = {
            toString() {
                throw new Error('toString 爆炸');
            },
        };
        Logger.logDir = join(dir, 'robust-message');
        const entries = captureStdout(() => Logger.error(/** @type {any} */ (nasty), { n: 1n }));
        assert.equal(entries.length, 1);
        assert.equal(entries[0].level, 'ERROR');
        assert.equal(entries[0].message, '[Unstringifiable]');
        assert.equal(entries[0].fields.n, '[BigInt 1]');
    });

    it('Logger.now 抛错或返回非法时间：退回真实时钟，日志照记', () => {
        const realNow = Logger.now;
        try {
            Logger.now = () => {
                throw new Error('时钟不可用');
            };
            const broken = captureStdout(() => Logger.error('时钟抛错'));
            assert.equal(broken.length, 1);
            assert.match(broken[0].time, /^\d{4}-\d{2}-\d{2}T/, '应退回可用的真实时间');

            Logger.now = () => new Date('不是时间');
            const invalid = captureStdout(() => Logger.error('非法时间'));
            assert.equal(invalid.length, 1);
            assert.ok(!invalid[0].time.startsWith('NaN'), '非法 Date 不得写出 NaN-NaN 时间戳');
        } finally {
            Logger.now = realNow;
        }
    });

    it('时间戳与等级恒在：fields 含不可序列化值时也不丢整行', () => {
        Logger.logDir = join(dir, 'robust-line');
        const entries = captureStdout(() => Logger.warn('兜底行测试', { first: { n: 1n } }));
        assert.equal(entries.length, 1);
        assert.equal(entries[0].level, 'WARN');
        assert.equal(entries[0].message, '兜底行测试');
        assert.equal(entries[0].fields.first.n, '[BigInt 1]');
        assert.match(entries[0].time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    });

    after(() => {
        Logger.logDir = previousDir;
    });
});

describe('Logger 文件通道：滚动状态含目录（当日换目录不丢日志）', () => {
    /** 当日日期 */
    const today = (() => {
        const n = new Date();
        const pad = (v) => String(v).padStart(2, '0');
        return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
    })();

    const previousDir = Logger.logDir;

    after(() => {
        Logger.logDir = previousDir;
    });

    /**
     * 断言指定目录当日文件存在且含指定消息
     *
     * @param {string} logDir 日志目录
     * @param {string[]} messages 期望的消息（按行序）
     */
    function assertTodayFile(logDir, messages) {
        const file = join(logDir, `app-${today}.log`);
        assert.ok(existsSync(file), `目录应被创建并写入：${file}`);
        const lines = readFileSync(file, 'utf8').trim().split('\n').map(parseLogLine);
        assert.deepEqual(lines.map((e) => e?.message), messages);
    }

    it('同一天内重设 Logger.logDir：新目录首写即被创建', () => {
        const a = join(dir, 'switch-a');
        const b = join(dir, 'switch-b');
        Logger.logDir = a;
        captureStdout(() => Logger.warn('A 首条'));
        Logger.logDir = b; // 日期未变：旧实现因此永不创建 b，日志静默丢到次日
        captureStdout(() => Logger.warn('B 首条'));
        assertTodayFile(a, ['A 首条']);
        assertTodayFile(b, ['B 首条']);
    });

    it('Config.setRootDir() 换宿主根（未显式指定 logDir）：新根下 log/ 首写即创建', () => {
        const explicit = Logger.logDir;
        const rootC = join(dir, 'root-c');
        mkdirSync(rootC, { recursive: true });
        Logger.logDir = null; // 目录回到"随宿主根解析"，换根即换目录
        Config.setRootDir(rootC);
        try {
            captureStdout(() => Logger.error('换根后首条'));
            assertTodayFile(join(rootC, 'log'), ['换根后首条']);
        } finally {
            Config.setRootDir(dir);
            Config.devConfigFile = devFixture;
            Logger.logDir = explicit;
        }
    });

    it('日志目录运行期被外部删除：下一次写入补建目录，不再静默丢到次日', () => {
        const d = join(dir, 'removed-mid-day');
        Logger.logDir = d;
        captureStdout(() => Logger.warn('删除前'));
        rmSync(d, { recursive: true, force: true });
        captureStdout(() => Logger.warn('删除后'));
        assertTodayFile(d, ['删除后']);
    });

    it('换目录后清理按目标目录进行，旧目录文件不受影响', () => {
        const old = join(dir, 'cleanup-old');
        const fresh = join(dir, 'cleanup-fresh');
        mkdirSync(old, { recursive: true });
        for (const stale of ['app-2020-01-01.log', 'app-2020-01-02.log', 'app-2020-01-03.log', 'app-2020-01-04.log']) {
            writeFileSync(join(old, stale), '', 'utf8');
        }
        Logger.logDir = old;
        captureStdout(() => Logger.warn('旧目录首条'));
        // src/logger.js 的 KEEP_DAYS = 3：当日文件计入保留数
        assert.equal(readdirSync(old).filter((n) => n.startsWith('app-')).length, 3);
        Logger.logDir = fresh;
        captureStdout(() => Logger.warn('新目录首条'));
        assertTodayFile(fresh, ['新目录首条']);
        assert.ok(existsSync(join(old, `app-${today}.log`)), '切走后旧目录当日文件不应被动');
    });
});
