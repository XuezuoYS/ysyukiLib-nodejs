import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Config } from '#YukiLib/config';

/**
 * dev.config.json 开发配置覆盖测试
 *
 * 全部经由可注入的 Config.devConfigFile 与预置缓存完成，
 * 不触碰真实 config.json / 宿主根 dev.config.json。
 */

const dir = mkdtempSync(join(tmpdir(), 'ysyuki-devcfg-'));

// 宿主根重定向到临时目录；必须在预置缓存之前
Config.setRootDir(dir);

/** @param {string} name @param {string} content @returns {string} 夹具绝对路径 */
function fixture(name, content) {
    const p = join(dir, name);
    writeFileSync(p, content, 'utf8');
    return p;
}

/** 预置 config.json 数据缓存（跳过真实文件读取） */
Config.isConfigLoaded = true;
Config.configData = {
    host: '127.0.0.1',
    port: 8000,
    'port.dev': 8001,
    'both.dev': 'alias-value',
};

/** @param {string} file dev 配置文件路径 @param {Record<string, any>} [data] 预置 dev 数据（给定则视为已加载） */
function useDev(file, data) {
    Config.devConfigFile = file;
    if (data === undefined) {
        Config.isDevConfigLoaded = false;
        Config.devConfigData = {};
    } else {
        Config.isDevConfigLoaded = true;
        Config.devConfigData = data;
    }
}

describe('Config.isDev()', () => {
    it('dev.config.json 文件存在为 true，不存在为 false（实时检查）', () => {
        useDev(join(dir, 'nope.json'));
        assert.equal(Config.isDev(), false);
        useDev(fixture('dev1.json', '{}'));
        assert.equal(Config.isDev(), true);
    });
});

describe('Config.getConfig() 开发覆盖优先级', () => {
    it('dev 文件同名键 > config {name}.dev 键 > 普通键', () => {
        useDev(fixture('dev2.json', JSON.stringify({ both: 'devfile-value', port: 9001 })));
        assert.equal(Config.getConfig('both'), 'devfile-value');
        assert.equal(Config.getConfig('port'), 9001);
        assert.equal(Config.getConfig('host'), '127.0.0.1');
    });

    it('dev 文件无同名键时 config {name}.dev 键生效', () => {
        useDev(fixture('dev3.json', JSON.stringify({ z: 1 })));
        assert.equal(Config.getConfig('both'), 'alias-value');
    });

    it('非开发模式：.dev 键与 dev 文件均不生效', () => {
        useDev(join(dir, 'nope2.json'));
        assert.equal(Config.getConfig('port'), 8000);
        assert.equal(Config.getConfig('both'), false);
    });

    it('dev 文件 JSON 解析失败：静默回退普通取值', () => {
        useDev(fixture('bad.json', '{invalid'));
        assert.equal(Config.isDev(), true);
        assert.equal(Config.getConfig('port'), 8000);
    });

    it('dev.config.json 带 BOM 仍可解析（Windows 记事本/PowerShell 常见）', () => {
        useDev(fixture('bomdev.json', '\uFEFF' + JSON.stringify({ port: 7777 })));
        assert.equal(Config.getConfig('port'), 7777);
    });

    it('dev 显式 false/0 覆盖值同样生效（按键存在判断，非按真值判断）', () => {
        useDev(fixture('unused.json', '{}'), { flag: false, zero: 0 });
        Config.configData.flag = true;
        Config.configData.zero = 999;
        assert.equal(Config.getConfig('flag'), false);
        assert.equal(Config.getConfig('zero'), 0);
    });
});

after(() => {
    Config.setRootDir(null);
    rmSync(dir, { recursive: true, force: true });
});
