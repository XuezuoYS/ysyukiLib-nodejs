import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';

import { Config } from '#YukiLib/config';

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

// 系统环境优先的哨兵值，必须在首次 envRead 之前注入
process.env.YSYUKI_TEST_ENV_BOTH = 'from-system';

Config.setRootDir(dir);

after(() => {
    Config.setRootDir(null);
    delete process.env.YSYUKI_TEST_ENV_BOTH;
    rmSync(dir, { recursive: true, force: true });
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
