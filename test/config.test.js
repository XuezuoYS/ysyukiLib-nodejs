import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
        } finally {
            Config.setRootDir(dir);
            rmSync(bare, { recursive: true, force: true });
        }
    });

    it('解析失败：告警一次并带解析原因，且不含文件内容', () => {
        const badDir = mkdtempSync(join(tmpdir(), 'ysyuki-warn-bad-'));
        writeFileSync(join(badDir, 'config.json'), '{"secret":"SHOULD-NOT-LEAK",}', 'utf8');
        Config.setRootDir(badDir);
        try {
            const entries = captureStdout(() => {
                assert.equal(Config.getConfig('secret'), false);
            });
            const warned = entries.filter((entry) => entry.message.includes('读取或解析失败'));
            assert.equal(warned.length, 1);
            assert.equal(warned[0].level, 'WARN');
            assert.equal(warned[0].fields.file, join(badDir, 'config.json'));
            assert.ok(warned[0].fields.reason.length > 0);
            assert.doesNotMatch(JSON.stringify(warned[0]), /SHOULD-NOT-LEAK/, '告警不得输出文件内容');
        } finally {
            Config.setRootDir(dir);
            rmSync(badDir, { recursive: true, force: true });
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
