import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';

import { Config } from '#YukiLib/config';
import { Logger } from '#YukiLib/logger';

import { captureStdout } from './loggerFixture.js';

/**
 * 宿主项目根夹具：库自身目录不含 config.json / .env，测试必须自带根目录
 */
const dir = mkdtempSync(join(tmpdir(), 'ysyuki-cfg-'));
writeFileSync(join(dir, 'config.json'), JSON.stringify({
    host: '127.0.0.1',
    port: 8000,
    nested: { a: 1 },
    flag: true,
}), 'utf8');
writeFileSync(join(dir, '.env'), 'YSYUKI_TEST_ENV_FILE_ONLY=from-file\nYSYUKI_TEST_ENV_BOTH=from-file\n', 'utf8');

/** 日志目录重定向到临时目录，避免配置告警落盘污染库自身目录 */
const logDir = mkdtempSync(join(tmpdir(), 'ysyuki-cfg-log-'));
Logger.logDir = logDir;

// 系统环境优先的哨兵值，必须在首次 envRead 之前注入
process.env.YSYUKI_TEST_ENV_BOTH = 'from-system';

Config.setRootDir(dir);

after(() => {
    Config.setRootDir(null);
    delete process.env.YSYUKI_TEST_ENV_BOTH;
    Logger.logDir = null;
    rmSync(dir, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
});

describe('Config：宿主项目根解析', () => {
    it('getRootDir：返回显式指定的根目录', () => {
        assert.equal(Config.getRootDir(), dir);
    });

    it('resolveFromRoot：基于宿主根解析，不传分段返回带尾分隔符的根', () => {
        assert.equal(Config.resolveFromRoot(), dir + sep);
        assert.equal(Config.resolveFromRoot('config.json'), join(dir, 'config.json'));
        assert.equal(Config.resolveFromRoot('CA', 'cacert.pem'), join(dir, 'CA', 'cacert.pem'));
    });

    it('devConfigFile：默认为宿主根下 dev.config.json', () => {
        assert.equal(Config.devConfigFile, join(dir, 'dev.config.json'));
    });

    it('setRootDir(null)：恢复自动解析（不再固定为夹具根）', () => {
        Config.setRootDir(dir);
        assert.equal(Config.getRootDir(), dir);
        Config.setRootDir(null);
        assert.notEqual(Config.getRootDir(), dir);
        Config.setRootDir(dir);
    });
});

describe('Config.getEnv', () => {
    it('显式设置的环境变量可读取', () => {
        process.env.YSYUKI_TEST_ENV_EXPLICIT = 'test-value';
        assert.equal(Config.getEnv('YSYUKI_TEST_ENV_EXPLICIT'), 'test-value');
        delete process.env.YSYUKI_TEST_ENV_EXPLICIT;
    });

    it('不存在的键返回 false', () => {
        assert.equal(Config.getEnv('YSYUKI_TEST_NOT_EXIST_KEY'), false);
    });

    it('.env 从宿主根加载：仅文件存在的键可读', () => {
        assert.equal(Config.getEnv('YSYUKI_TEST_ENV_FILE_ONLY'), 'from-file');
    });

    it('系统环境优先于 .env（loadEnvFile 不覆盖已存在键）', () => {
        assert.equal(Config.getEnv('YSYUKI_TEST_ENV_BOTH'), 'from-system');
    });

    it('.env 缺失时静默忽略（不抛错，未设置的键仍返回 false）', () => {
        const bare = mkdtempSync(join(tmpdir(), 'ysyuki-noenv-'));
        Config.setRootDir(bare);
        try {
            assert.equal(Config.envRead(), true);
            assert.equal(Config.getEnv('YSYUKI_TEST_ENV_NEVER_SET'), false);
        } finally {
            Config.setRootDir(dir);
            rmSync(bare, { recursive: true, force: true });
        }
    });
});

describe('Config.getConfig', () => {
    it('读取宿主根 config.json 中的 host/port/nested/flag', () => {
        assert.equal(Config.getConfig('host'), '127.0.0.1');
        assert.equal(Config.getConfig('port'), 8000);
        assert.deepEqual(Config.getConfig('nested'), { a: 1 });
        assert.equal(Config.getConfig('flag'), true);
    });

    it('不存在的键返回 false', () => {
        assert.equal(Config.getConfig('ysyuki_test_not_exist'), false);
    });

    it('config.json 缺失时返回 false（不抛错）', () => {
        const bare = mkdtempSync(join(tmpdir(), 'ysyuki-nocfg-'));
        Config.setRootDir(bare);
        try {
            assert.equal(Config.getConfig('host'), false);
        } finally {
            Config.setRootDir(dir);
            rmSync(bare, { recursive: true, force: true });
        }
    });

    it('懒加载：envRead/configRead 幂等', () => {
        Config.envRead();
        Config.envRead();
        Config.configRead();
        Config.configRead();
        assert.equal(Config.isEnvLoaded, true);
        assert.equal(Config.isConfigLoaded, true);
    });
});

/**
 * 直接取 JSON.parse 的原始失败消息
 *
 * 用于"自校验夹具"：确认当前 V8 在这种坏 JSON 上确实会把文件原文片段写进 message，
 * 否则下面的脱敏断言就是空测试（trailing-comma 之类形态不会内泄，早年正是因此漏掉 B4）。
 *
 * @param {string} content 坏 JSON 文本
 * @returns {string} SyntaxError 的 message；意外解析成功时返回空串
 */
function rawParseMessage(content) {
    try {
        JSON.parse(content);
        return '';
    } catch (err) {
        return err instanceof Error ? err.message : String(err);
    }
}

describe('Config：config.json 不可用告警（M4）', () => {
    it('文件缺失：告警一次并带上路径与原因，重复取值不刷屏', () => {
        const bare = mkdtempSync(join(tmpdir(), 'ysyuki-warn-missing-'));
        Config.setRootDir(bare);
        try {
            const entries = captureStdout(() => {
                assert.equal(Config.getConfig('host'), false);
                assert.equal(Config.getConfig('host'), false);
                assert.equal(Config.getConfig('other'), false);
            });
            const warned = entries.filter((entry) => entry.message.includes('config.json 不存在'));
            assert.equal(warned.length, 1, '同一宿主根只应告警一次');
            assert.equal(warned[0].level, 'WARN');
            assert.equal(warned[0].fields.file, join(bare, 'config.json'));
            assert.match(warned[0].fields.reason, /ENOENT|no such file/i);
            assert.doesNotMatch(warned[0].fields.reason, /[\\/]/, '原因不带路径（路径由 file 字段给出）');
        } finally {
            Config.setRootDir(dir);
            rmSync(bare, { recursive: true, force: true });
        }
    });

    it('解析失败：原因脱敏，V8 消息里的原文片段不得进日志（B4）', () => {
        // 这两种坏 JSON 都走 V8 "把原文片段写进 message" 的分支：
        //   SyntaxError: Unexpected token 'D', "DB_PASSWOR"... is not valid JSON
        //   SyntaxError: Unexpected token 'S', "{"pw": S3cr3t-P@s"... is not valid JSON
        // 旧实现把 err.message 原样写入 reason，于是键名 / 口令片段同时进了 stdout 与日志文件，
        // 与同文件声明的"不输出文件内容"承诺直接矛盾。
        // 注意：行尾逗号（`,}`）形态走 "Expected ... in JSON at position N" 分支，
        // 消息里不含内容片段——最初的夹具正是因此一直没暴露这条泄漏路径。
        const cases = /** @type {const} */ ([
            ['DB_PASSWORD=S3cr3t-P@ss!, {broken', /DB_PASSWOR/],
            ['{"pw": S3cr3t-P@ssw0rd}', /S3cr3t-P@s/],
        ]);

        for (const [content, leaked] of cases) {
            // 自校验：确认当前 V8 在这种坏 JSON 上确实内泄（否则本用例是空测试；
            // 若日后 V8 改了文案形态，请换用仍会内泄的形态，而不是删掉这条断言）
            assert.match(rawParseMessage(content), leaked, '夹具应确实会内泄内容片段');

            const badDir = mkdtempSync(join(tmpdir(), 'ysyuki-warn-bad-'));
            writeFileSync(join(badDir, 'config.json'), content, 'utf8');
            Config.setRootDir(badDir);
            try {
                const entries = captureStdout(() => {
                    assert.equal(Config.getConfig('pw'), false);
                });
                const warned = entries.filter((entry) => entry.message.includes('读取或解析失败'));
                assert.equal(warned.length, 1);
                assert.equal(warned[0].level, 'WARN');
                assert.equal(warned[0].fields.file, join(badDir, 'config.json'));
                assert.ok(warned[0].fields.reason.length > 0, '仍须给出可判读的原因');
                const line = JSON.stringify(warned[0]);
                assert.doesNotMatch(line, leaked, '告警不得输出文件内容片段');
                assert.doesNotMatch(line, /S3cr3t/, '告警不得输出配置值');
            } finally {
                Config.setRootDir(dir);
                rmSync(badDir, { recursive: true, force: true });
            }
        }
    });

    it('解析失败（不内泄的形态）：同样只给脱敏原因', () => {
        const badDir = mkdtempSync(join(tmpdir(), 'ysyuki-warn-comma-'));
        writeFileSync(join(badDir, 'config.json'), '{"secret":"SHOULD-NOT-LEAK",}', 'utf8');
        Config.setRootDir(badDir);
        try {
            const entries = captureStdout(() => {
                assert.equal(Config.getConfig('secret'), false);
            });
            const warned = entries.filter((entry) => entry.message.includes('读取或解析失败'));
            assert.equal(warned.length, 1);
            assert.equal(warned[0].fields.file, join(badDir, 'config.json'));
            assert.match(warned[0].fields.reason, /SyntaxError|JSON/);
            assert.doesNotMatch(JSON.stringify(warned[0]), /SHOULD-NOT-LEAK/, '告警不得输出文件内容');
        } finally {
            Config.setRootDir(dir);
            rmSync(badDir, { recursive: true, force: true });
        }
    });

    it('读取失败（非 ENOENT）：走通用文案，原因为 errno 码且不含路径', () => {
        const dirAsFile = mkdtempSync(join(tmpdir(), 'ysyuki-warn-eisdir-'));
        // config.json 位置放一个目录：readFileSync 抛 EISDIR（Windows 下亦可能 EPERM）
        mkdirSync(join(dirAsFile, 'config.json'));
        Config.setRootDir(dirAsFile);
        try {
            const entries = captureStdout(() => {
                assert.equal(Config.getConfig('host'), false);
            });
            const warned = entries.filter((entry) => entry.message.includes('读取或解析失败'));
            assert.equal(warned.length, 1);
            assert.doesNotMatch(warned[0].message, /不存在/);
            assert.match(warned[0].fields.reason, /^E(ISDIR|PERM|ACCES)/);
            assert.doesNotMatch(warned[0].fields.reason, /[\\/]/, '原因里不带路径（路径由 file 字段给出）');
        } finally {
            Config.setRootDir(dir);
            rmSync(dirAsFile, { recursive: true, force: true });
        }
    });

    it('setRootDir 重置告警标记：换到新的缺失根目录会再次告警', () => {
        const first = mkdtempSync(join(tmpdir(), 'ysyuki-warn-a-'));
        const second = mkdtempSync(join(tmpdir(), 'ysyuki-warn-b-'));
        try {
            Config.setRootDir(first);
            assert.equal(captureStdout(() => Config.getConfig('host')).filter((e) => e.message.includes('config.json 不存在')).length, 1);

            Config.setRootDir(second);
            const entries = captureStdout(() => Config.getConfig('host'));
            const warned = entries.filter((entry) => entry.message.includes('config.json 不存在'));
            assert.equal(warned.length, 1);
            assert.equal(warned[0].fields.file, join(second, 'config.json'));
        } finally {
            Config.setRootDir(dir);
            rmSync(first, { recursive: true, force: true });
            rmSync(second, { recursive: true, force: true });
        }
    });

    it('config.json 正常时不告警', () => {
        const entries = captureStdout(() => {
            Config.setRootDir(dir);
            assert.equal(Config.getConfig('port'), 8000);
        });
        assert.deepEqual(entries.filter((entry) => entry.message.includes('config.json')), []);
    });
});

/**
 * UTF-8 BOM 解码后的字符（U+FEFF）与 CRLF 行尾
 *
 * 记事本与 PowerShell 5.1 的 `Set-Content -Encoding UTF8` 写出的文件正是
 * "BOM + CRLF" 形态，`.env` 夹具需还原到字节级一致。
 */
const BOM_CHAR = '\uFEFF';
const CRLF = '\r\n';

/**
 * 当前 `process.env` 中以 UTF-8 BOM 起始的键名
 *
 * `.env` 带 BOM 而未被剥离时，首键会被写成 `BOM_CHAR + 'KEY'`：按正常键名取不到，
 * 还会被子进程继承，故加载修复后必须为空。
 *
 * @returns {string[]} 坏键名列表
 */
function bomEnvKeys() {
    return Object.keys(process.env).filter((key) => key.charCodeAt(0) === 0xFEFF);
}

/**
 * 删除测试引入的环境变量（连同可能的 BOM 前缀坏键一起清，保持用例自包含）
 *
 * @param {...string} keys 键名
 * @returns {void}
 */
function cleanupEnv(...keys) {
    for (const key of keys) {
        delete process.env[key];
        delete process.env[BOM_CHAR + key];
    }
}

/**
 * 生成一个宿主根临时目录，其 `.env` 以 UTF-8 BOM 开头并使用 CRLF 行尾
 *
 * @param {string} content `.env` 正文（不含 BOM，原样写入）
 * @returns {string} 宿主根绝对路径
 */
function rootWithBomEnv(content) {
    const bomDir = mkdtempSync(join(tmpdir(), 'ysyuki-envbom-'));
    writeFileSync(join(bomDir, '.env'), Buffer.from(BOM_CHAR + content, 'utf8'));
    return bomDir;
}

describe('Config：UTF-8 BOM 容忍', () => {
    it('config.json 带 BOM 仍可解析（Windows 记事本/PowerShell 常见）', () => {
        const bomDir = mkdtempSync(join(tmpdir(), 'ysyuki-bom-'));
        writeFileSync(join(bomDir, 'config.json'), '\uFEFF' + JSON.stringify({ port: 9000 }), 'utf8');
        Config.setRootDir(bomDir);
        try {
            assert.equal(Config.getConfig('port'), 9000);
        } finally {
            Config.setRootDir(dir);
            rmSync(bomDir, { recursive: true, force: true });
        }
    });

    it('.env 带 BOM：首个键与其余键一样可取，且不残留坏键', () => {
        const bomDir = rootWithBomEnv(`YSYUKI_TEST_BOM_FIRST=from-file${CRLF}YSYUKI_TEST_BOM_SECOND=from-file${CRLF}`);
        Config.setRootDir(bomDir);
        try {
            // 首键是 BOM 唯一能影响到的键；次键在旧实现下同样正常，写在这里是为了把现象
            // 钉在"只坏第一个"上，避免修复被误做成"整个文件自己重新解析一遍"。
            assert.equal(Config.getEnv('YSYUKI_TEST_BOM_FIRST'), 'from-file');
            assert.equal(Config.getEnv('YSYUKI_TEST_BOM_SECOND'), 'from-file');
            assert.deepEqual(bomEnvKeys(), [], '不得残留 BOM 前缀键名（会被子进程继承）');
            assert.equal(Config.envRead(), true, '重复加载幂等');
        } finally {
            cleanupEnv('YSYUKI_TEST_BOM_FIRST', 'YSYUKI_TEST_BOM_SECOND');
            Config.setRootDir(dir);
            rmSync(bomDir, { recursive: true, force: true });
        }
    });

    it('.env 带 BOM 且系统环境已有同名首键：系统值优先，坏键仍被清掉', () => {
        // loadEnvFile 的"已存在键不覆盖"检查是对**坏键名**做的，于是文件值仍以坏键名落进
        // process.env；修复若只做"坏键改名"就会把文件值盖到系统值上，故单独覆盖一条。
        process.env.YSYUKI_TEST_BOM_BOTH = 'from-system';
        const bomDir = rootWithBomEnv(`YSYUKI_TEST_BOM_BOTH=from-file${CRLF}YSYUKI_TEST_BOM_TAIL=from-file${CRLF}`);
        Config.setRootDir(bomDir);
        try {
            assert.equal(Config.getEnv('YSYUKI_TEST_BOM_BOTH'), 'from-system');
            assert.equal(Config.getEnv('YSYUKI_TEST_BOM_TAIL'), 'from-file');
            assert.deepEqual(bomEnvKeys(), [], '修复不得把文件值写进系统已有的键');
        } finally {
            cleanupEnv('YSYUKI_TEST_BOM_BOTH', 'YSYUKI_TEST_BOM_TAIL');
            Config.setRootDir(dir);
            rmSync(bomDir, { recursive: true, force: true });
        }
    });

    it('夹具自校验：Node 原生 loadEnvFile 确实会把 BOM 并入首键名', () => {
        const bomDir = rootWithBomEnv(`YSYUKI_TEST_BOM_RAW=from-file${CRLF}`);
        try {
            process.loadEnvFile(join(bomDir, '.env'));
            // 若此断言失败，说明 Node 已自行剥离 BOM：请连同 Config.envRead 里的
            // repairBomEnvKeys 调用与上面两条用例的坏键断言一并删除，而不是删掉本断言。
            assert.ok(bomEnvKeys().includes(BOM_CHAR + 'YSYUKI_TEST_BOM_RAW'), '原生解析器应产出 BOM 前缀键名');
        } finally {
            cleanupEnv('YSYUKI_TEST_BOM_RAW');
            rmSync(bomDir, { recursive: true, force: true });
        }
    });

    it('.env 带 BOM 且首行为 export / 缩进形态：整行不被匹配，告警一次且不泄漏键名与值', () => {
        // 与首键用例相对：Node 不把 U+FEFF 当空白，`\uFEFFexport KEY=v`、`\uFEFF  KEY=v`
        // 整行匹配失败，值从未进入 process.env —— 本库不接管 .env 解析，无从改名恢复，
        // 于是把这声"文件明明存在却少一个键"记成 WARN（只报路径与固定原因）。
        const cases = /** @type {const} */ ([
            ['export YSYUKI_TEST_BOM_EXP=exp-secret-value', 'YSYUKI_TEST_BOM_EXP'],
            ['  YSYUKI_TEST_BOM_IND=ind-secret-value', 'YSYUKI_TEST_BOM_IND'],
        ]);

        for (const [firstLine, key] of cases) {
            const bomDir = rootWithBomEnv(`${firstLine}${CRLF}YSYUKI_TEST_BOM_AFTER=ok${CRLF}`);
            Config.setRootDir(bomDir);
            try {
                const entries = captureStdout(() => {
                    assert.equal(Config.getEnv(key), false, '原生解析器整行丢弃');
                    assert.equal(Config.getEnv('YSYUKI_TEST_BOM_AFTER'), 'ok', 'BOM 只影响第一行');
                    assert.equal(Config.getEnv(key), false, '重复取值不得刷屏');
                });
                const warned = entries.filter((entry) => entry.message.includes('.env 首行未被加载'));
                assert.equal(warned.length, 1, '同一宿主根只应告警一次');
                assert.equal(warned[0].level, 'WARN');
                assert.equal(warned[0].fields.file, join(bomDir, '.env'));
                assert.match(warned[0].fields.reason, /UTF-8 BOM/);
                assert.match(warned[0].fields.reason, /export|缩进/);

                const line = JSON.stringify(warned[0]);
                assert.doesNotMatch(line, /YSYUKI_TEST_BOM_EXP|YSYUKI_TEST_BOM_IND/, '告警不得输出键名（键名也是文件内容）');
                assert.doesNotMatch(line, /exp-secret-value|ind-secret-value|YSYUKI_TEST_BOM_AFTER/, '告警不得输出配置值');
                assert.deepEqual(bomEnvKeys(), [], '坏形态同样不得残留 BOM 前缀键');
            } finally {
                cleanupEnv(key, 'YSYUKI_TEST_BOM_AFTER');
                Config.setRootDir(dir);
                rmSync(bomDir, { recursive: true, force: true });
            }
        }
    });

    it('不该出声的 BOM 形态：已修复、注释首行、系统已提供，均不告警', () => {
        // 告警只留给"确实丢了一个键"的情形；下列三条都能正常取值，若也写 WARN，
        // 宿主日志就会被正常路径刷屏（脱敏告警的价值就在于一响就一定有东西没生效）。
        const cases = [
            { label: '首键污染已被修复', first: 'YSYUKI_TEST_BOM_Q1=v1', second: 'YSYUKI_TEST_BOM_Q1_T=t', key: 'YSYUKI_TEST_BOM_Q1', systemValue: '', expected: 'v1' },
            { label: 'BOM 后首行是注释', first: '# comment', second: 'YSYUKI_TEST_BOM_Q2=v2', key: 'YSYUKI_TEST_BOM_Q2', systemValue: '', expected: 'v2' },
            { label: '系统环境已提供首键', first: 'YSYUKI_TEST_BOM_Q3=from-file', second: 'YSYUKI_TEST_BOM_Q3_T=t', key: 'YSYUKI_TEST_BOM_Q3', systemValue: 'from-system', expected: 'from-system' },
        ];

        for (const c of cases) {
            if (c.systemValue !== '') {
                process.env[c.key] = c.systemValue;
            }
            const bomDir = rootWithBomEnv(`${c.first}${CRLF}${c.second}${CRLF}`);
            Config.setRootDir(bomDir);
            try {
                const entries = captureStdout(() => {
                    assert.equal(Config.getEnv(c.key), c.expected, c.label);
                });
                assert.deepEqual(entries.filter((entry) => entry.message.includes('.env')), [], `${c.label}：不应因 .env 告警`);
                assert.deepEqual(bomEnvKeys(), [], `${c.label}：不得残留 BOM 前缀键`);
            } finally {
                cleanupEnv(c.key, c.second.split('=')[0]);
                Config.setRootDir(dir);
                rmSync(bomDir, { recursive: true, force: true });
            }
        }
    });
});

describe('Config：路径可定位性', () => {
    it('resolveFromRoot 解析出的文件真实存在', () => {
        assert.equal(existsSync(Config.resolveFromRoot('config.json')), true);
        assert.equal(existsSync(Config.resolveFromRoot('.env')), true);
    });
});

describe('Config：config.json 顶层内容非对象（B3）', () => {
    /**
     * 生成一个宿主根临时目录，其 config.json 内容为指定文本
     *
     * @param {string} tag 临时目录前缀
     * @param {string} content config.json 内容（原样写入，不经 JSON.stringify）
     * @returns {string} 宿主根绝对路径
     */
    function rootWithConfig(tag, content) {
        const custom = mkdtempSync(join(tmpdir(), tag));
        writeFileSync(join(custom, 'config.json'), content, 'utf8');
        return custom;
    }

    it('内容整体为 null：getConfig 返回 false（兑现容错承诺，不抛 TypeError）', () => {
        const nullDir = rootWithConfig('ysyuki-nullcfg-', 'null');
        Config.setRootDir(nullDir);
        try {
            assert.doesNotThrow(() => Config.getConfig('host'));
            assert.equal(Config.getConfig('host'), false);
            assert.equal(Config.configRead(), false, '顶层非对象应视为读取失败');
            assert.equal(Config.isConfigLoaded, false, '失败不得置为已加载');
            assert.deepEqual(Config.configData, {}, '失败不得把缓存写成 null');
        } finally {
            Config.setRootDir(dir);
            rmSync(nullDir, { recursive: true, force: true });
        }
    });

    it('内容整体为 null：按"不可用"告警一次且说明原因', () => {
        const nullDir = rootWithConfig('ysyuki-nullwarn-', 'null');
        Config.setRootDir(nullDir);
        try {
            const entries = captureStdout(() => {
                assert.equal(Config.getConfig('host'), false);
                assert.equal(Config.getConfig('host'), false);
            });
            const warned = entries.filter((entry) => entry.message.includes('读取或解析失败'));
            assert.equal(warned.length, 1, '同一宿主根只应告警一次');
            assert.equal(warned[0].level, 'WARN');
            assert.equal(warned[0].fields.file, join(nullDir, 'config.json'));
            assert.match(warned[0].fields.reason, /内容不是对象（实际为 null）/);
        } finally {
            Config.setRootDir(dir);
            rmSync(nullDir, { recursive: true, force: true });
        }
    });

    it('内容整体为数字 / 字符串 / 布尔：同样返回 false 并告警', () => {
        for (const content of ['123', '"a string"', 'true']) {
            const scalarDir = rootWithConfig('ysyuki-scalarcfg-', content);
            Config.setRootDir(scalarDir);
            try {
                const entries = captureStdout(() => {
                    assert.doesNotThrow(() => Config.getConfig('host'));
                    assert.equal(Config.getConfig('host'), false, `内容 ${content} 应取不到任何键`);
                });
                assert.equal(entries.filter((entry) => entry.message.includes('读取或解析失败')).length, 1);
            } finally {
                Config.setRootDir(dir);
                rmSync(scalarDir, { recursive: true, force: true });
            }
        }
    });

    it('内容整体为数组：保持既有语义（按键取不到返回 false，不抛错）', () => {
        const arrayDir = rootWithConfig('ysyuki-arraycfg-', '[1,2]');
        Config.setRootDir(arrayDir);
        try {
            assert.equal(Config.getConfig('host'), false);
            assert.equal(Config.configRead(), true);
        } finally {
            Config.setRootDir(dir);
            rmSync(arrayDir, { recursive: true, force: true });
        }
    });

    it('缓存被外部直接赋值为 null：取值返回 false 而非抛 TypeError', () => {
        Config.configRead();
        const original = Config.configData;
        Config.configData = /** @type {any} */ (null);
        try {
            assert.doesNotThrow(() => Config.getConfig('host'));
            assert.equal(Config.getConfig('host'), false);
        } finally {
            Config.configData = original;
        }
    });
});
