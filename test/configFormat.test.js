import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Config } from '#YukiLib/config';
import { Logger } from '#YukiLib/logger';

import { captureStdout } from './loggerFixture.js';

/**
 * 配置格式（`Config.choiceFormat` / `Config.configFormat`）
 *
 * 覆盖默认值 `'yaml'`、格式切换后读哪个文件、开发环境判定只看当前格式的 dev 文件、
 * 以及 YAML 解析失败时的脱敏告警。JSON 专属断言（V8 SyntaxError 文案等）在 config.test.js，
 * dev 覆盖优先级的矩阵在 configDev.test.js（两者都把格式显式钉在 `'json'`）。
 */

// 本文件是独立测试进程：导入后、任何调用前的格式必须就是默认的 yaml
assert.equal(Config.configFormat, 'yaml', '默认配置格式应为 yaml');

/** 本文件创建的临时宿主根，退出时统一清理 */
const roots = [];

/** 日志目录重定向到临时目录，避免配置告警落盘污染库自身目录 */
const logDir = mkdtempSync(join(tmpdir(), 'ysyuki-fmt-log-'));
Logger.logDir = logDir;

/**
 * 造一个宿主根临时目录
 *
 * @param {string} tag 目录前缀
 * @param {Record<string, string>} files 文件名 → 内容
 * @returns {string} 宿主根绝对路径
 */
function makeRoot(tag, files) {
    const root = mkdtempSync(join(tmpdir(), tag));
    roots.push(root);
    for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(root, name), content, 'utf8');
    }
    return root;
}

beforeEach(() => {
    Config.setRootDir(null);
    Config.choiceFormat('yaml');
});

afterEach(() => {
    Config.setRootDir(null);
    Config.choiceFormat('yaml');
});

after(() => {
    Logger.logDir = null;
    rmSync(logDir, { recursive: true, force: true });
    for (const root of roots) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe('Config：配置格式', () => {
    it('默认格式是 yaml，且只读 config.yaml', () => {
        assert.equal(Config.configFormat, 'yaml');

        const root = makeRoot('ysyuki-fmt-default-', {
            'config.yaml': 'name: from-yaml\nport: 8000\n',
            'config.json': '{"name":"from-json","port":9000}',
        });
        Config.setRootDir(root);

        assert.equal(Config.getConfig('name'), 'from-yaml', 'yaml 模式下应读 config.yaml');
        assert.equal(Config.resolveFromRoot('config.yaml'), join(root, 'config.yaml'));
    });

    it('choiceFormat("json") 后只读 config.json（同一宿主根、无需手动清缓存）', () => {
        const root = makeRoot('ysyuki-fmt-switch-', {
            'config.yaml': 'name: from-yaml\n',
            'config.json': '{"name":"from-json"}',
        });
        Config.setRootDir(root);
        assert.equal(Config.getConfig('name'), 'from-yaml');

        Config.choiceFormat('json');
        assert.equal(Config.configFormat, 'json');
        assert.equal(Config.getConfig('name'), 'from-json', '切换格式应立即生效（缓存已失效）');

        Config.choiceFormat('yaml');
        assert.equal(Config.getConfig('name'), 'from-yaml', '切回 yaml 同样立即生效');
    });

    it('严格按格式：只有 config.json 时 yaml 模式取不到值并告警 config.yaml', () => {
        const root = makeRoot('ysyuki-fmt-strict-', {
            'config.json': '{"name":"from-json"}',
        });
        Config.setRootDir(root);

        const entries = captureStdout(() => {
            assert.equal(Config.getConfig('name'), false);
            assert.equal(Config.getConfig('name'), false);
        });
        const warned = entries.filter((entry) => entry.message.includes('config.yaml 不存在'));
        assert.equal(warned.length, 1, '同一宿主根只告警一次');
        assert.equal(warned[0].level, 'WARN');
        assert.equal(warned[0].fields.file, join(root, 'config.yaml'));
    });

    it('yaml 模式能读压缩 / 美化后的 JSON 内容（config.json 改名迁移路径）', () => {
        const source = { host: '127.0.0.1', port: 8080, nested: { list: [1, 2] } };
        for (const [tag, content] of /** @type {const} */ ([
            ['ysyuki-fmt-jsoncompact-', JSON.stringify(source)],
            ['ysyuki-fmt-jsonpretty-', JSON.stringify(source, null, 2)],
        ])) {
            const root = makeRoot(tag, { 'config.yaml': content });
            Config.setRootDir(root);
            assert.deepEqual(Config.getConfig('host'), source.host);
            assert.equal(Config.getConfig('port'), source.port);
            assert.deepEqual(Config.getConfig('nested'), source.nested);
        }
    });

    it('isDev() 只看当前格式对应的 dev 文件', () => {
        const root = makeRoot('ysyuki-fmt-devdetect-', {
            'config.yaml': 'name: x\n',
            'dev.config.json': '{"name":"json-dev"}',
        });
        Config.setRootDir(root);
        assert.equal(Config.isDev(), false, 'yaml 模式下 dev.config.json 不算开发环境');

        Config.choiceFormat('json');
        assert.equal(Config.isDev(), true, 'json 模式下 dev.config.json 生效');

        const yamlRoot = makeRoot('ysyuki-fmt-devdetect2-', {
            'config.yaml': 'name: x\n',
            'dev.config.yaml': 'name: yaml-dev\n',
        });
        // 注意：格式不随 setRootDir 重置，须显式切回 yaml
        Config.choiceFormat('yaml');
        Config.setRootDir(yamlRoot);
        assert.equal(Config.isDev(), true);
        Config.choiceFormat('json');
        assert.equal(Config.isDev(), false, 'json 模式下 dev.config.yaml 不算开发环境');
    });

    it('yaml 模式下的取值优先级：dev.config.yaml[name] > config.yaml[name.dev] > config.yaml[name]', () => {
        const root = makeRoot('ysyuki-fmt-precedence-', {
            'config.yaml': 'port: 8000\nport.dev: 8001\nboth: "normal"\nboth.dev: "alias"\n',
        });
        Config.setRootDir(root);
        assert.equal(Config.getConfig('port'), 8000, '无 dev 文件：普通键');

        writeFileSync(join(root, 'dev.config.yaml'), 'both: "devfile"\n', 'utf8');
        Logger.resetDevCache();
        assert.equal(Config.isDev(), true);
        assert.equal(Config.getConfig('both'), 'devfile', 'dev 文件同名键优先');
        assert.equal(Config.getConfig('port'), 8001, 'dev 文件没有的键走 {name}.dev');

        // dev 文件内容不是对象：整段开发覆盖跳过（连 {name}.dev 别名也不查），回退普通取值——
        // 这是既有契约"dev 文件缺失/解析失败/内容不是对象时静默回退普通取值"的原文语义
        writeFileSync(join(root, 'dev.config.yaml'), 'null\n', 'utf8');
        Config.setRootDir(root);
        assert.equal(Config.getConfig('both'), 'normal', 'dev 内容非对象时按普通键取值');
        assert.equal(Config.getConfig('port'), 8000, 'dev 不可用时 {name}.dev 也不生效');
    });

    it('Logger.defaultLevel 跟随当前格式的 dev 文件（切换格式会失效缓存）', () => {
        const root = makeRoot('ysyuki-fmt-level-', {
            'config.yaml': 'name: x\n',
            'dev.config.json': '{}\n',
        });
        Config.setRootDir(root);
        Logger.resetDevCache();
        assert.equal(Logger.defaultLevel, 'warn', 'yaml 模式下没有 dev.config.yaml');

        Config.choiceFormat('json');
        assert.equal(Logger.defaultLevel, 'info', 'choiceFormat 应主动失效 dev 判定缓存');

        Config.choiceFormat('yaml');
        Logger.resetDevCache();
        assert.equal(Logger.defaultLevel, 'warn');
    });

    it('setRootDir 与 choiceFormat 互不重置对方', () => {
        const root = makeRoot('ysyuki-fmt-independent-', {
            'config.json': '{"name":"from-json","port":1}',
        });
        Config.choiceFormat('json');
        Config.setRootDir(root);
        assert.equal(Config.configFormat, 'json', 'setRootDir 不重置格式');

        const other = makeRoot('ysyuki-fmt-independent2-', {
            'config.json': '{"name":"from-json","port":2}',
        });
        Config.setRootDir(other);
        assert.equal(Config.configFormat, 'json');
        assert.equal(Config.getConfig('name'), 'from-json');
        assert.equal(Config.getRootDir(), other, 'choiceFormat 不影响宿主根');
    });

    it('非法格式抛 TypeError（不静默回退）', () => {
        for (const bad of ['yaml2', 'YAML', 'toml', '', null, 123, {}]) {
            assert.throws(
                () => Config.choiceFormat(/** @type {any} */ (bad)),
                (error) => error instanceof TypeError && /choiceFormat/.test(error.message),
                `格式 ${JSON.stringify(bad)} 应被拒绝`,
            );
        }
        // 无参调用同样拒绝（choiceFormat 是设置方法，不是读取方法）
        assert.throws(() => Config.choiceFormat(/** @type {any} */ (undefined)), TypeError);
        assert.equal(Config.configFormat, 'yaml', '非法调用不得改变当前格式');
    });

    it('非法格式报错不回显任意长文本', () => {
        const long = 'x'.repeat(500);
        assert.throws(
            () => Config.choiceFormat(/** @type {any} */ (long)),
            (error) => error instanceof TypeError
                && !error.message.includes(long)
                && error.message.includes('500 字符'),
        );
    });
});

describe('Config：yaml 配置的失败形态与脱敏告警', () => {
    it('YAML 解析失败：告警一次，原因只有类别与行列，不含原文与值', () => {
        const secret = 'S3cr3t-P@ssw0rd';
        const root = makeRoot('ysyuki-fmt-badyaml-', {
            'config.yaml': `password: "unterminated ${secret}\n`,
        });
        Config.setRootDir(root);

        const entries = captureStdout(() => {
            assert.equal(Config.getConfig('password'), false);
            assert.equal(Config.getConfig('password'), false);
        });
        const warned = entries.filter((entry) => entry.message.includes('读取或解析失败'));
        assert.equal(warned.length, 1, '同一宿主根只告警一次');
        assert.equal(warned[0].level, 'WARN');
        assert.equal(warned[0].fields.file, join(root, 'config.yaml'));
        assert.match(warned[0].fields.reason, /YAML (scan|parse) 错误/);
        assert.match(warned[0].fields.reason, /第 \d+ 行第 \d+ 列/);

        const line = JSON.stringify(warned[0]);
        assert.doesNotMatch(line, /S3cr3t/, '告警不得输出配置值');
        assert.doesNotMatch(line, /unterminated/, '告警不得输出文件原文');
    });

    it('YAML 顶层不是对象：一律返回 false 并说明原因', () => {
        for (const content of ['null\n', '123\n', '"text"\n', '~ ']) {
            const root = makeRoot('ysyuki-fmt-nonobj-', { 'config.yaml': content });
            Config.setRootDir(root);
            const entries = captureStdout(() => {
                assert.doesNotThrow(() => Config.getConfig('host'));
                assert.equal(Config.getConfig('host'), false, `内容 ${JSON.stringify(content)} 应取不到任何键`);
            });
            const warned = entries.filter((entry) => entry.message.includes('读取或解析失败'));
            assert.equal(warned.length, 1);
            assert.match(warned[0].fields.reason, /内容不是对象/);
        }
    });

    it('YAML 顶层是数组：沿用 JSON 的既有语义（按键取不到，但算读取成功）', () => {
        const root = makeRoot('ysyuki-fmt-array-', { 'config.yaml': '- 1\n- 2\n' });
        Config.setRootDir(root);
        assert.equal(Config.configRead(), true);
        assert.equal(Config.getConfig('host'), false);
    });

    it('YAML 多文档：按解析失败处理（配置文件应是单文档）', () => {
        const root = makeRoot('ysyuki-fmt-multidoc-', { 'config.yaml': '--- 1\n--- 2\n' });
        Config.setRootDir(root);

        const entries = captureStdout(() => {
            assert.equal(Config.getConfig('a'), false);
        });
        const warned = entries.filter((entry) => entry.message.includes('读取或解析失败'));
        assert.equal(warned.length, 1);
        assert.match(warned[0].fields.reason, /YAML parse 错误/);
    });

    it('config.yaml 位置放目录：走通用文案，原因为 errno 码', () => {
        const root = makeRoot('ysyuki-fmt-eisdir-', {});
        mkdirSync(join(root, 'config.yaml'));
        Config.setRootDir(root);

        const entries = captureStdout(() => {
            assert.equal(Config.getConfig('host'), false);
        });
        const warned = entries.filter((entry) => entry.message.includes('读取或解析失败'));
        assert.equal(warned.length, 1);
        assert.doesNotMatch(warned[0].message, /不存在/);
        assert.equal(warned[0].fields.file, join(root, 'config.yaml'));
        assert.match(warned[0].fields.reason, /^E(ISDIR|PERM|ACCES)/);
        assert.doesNotMatch(warned[0].fields.reason, /[\\/]/, '原因里不带路径（路径由 file 字段给出）');
    });
});
