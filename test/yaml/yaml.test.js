import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { Config } from '#YukiLib/config';
import { Yaml, YamlError } from '#YukiLib/yaml';

/** 宿主根夹具：临时目录，绝不依赖库自身目录下的任何文件 */
const hostRoot = mkdtempSync(join(tmpdir(), 'yuki-yaml-'));

before(() => {
    Config.setRootDir(hostRoot);
});

after(() => {
    Config.setRootDir(null);
    rmSync(hostRoot, { recursive: true, force: true });
});

/**
 * YAML 入口的对外契约：文本解析、文件读取、选项校验
 *
 * 文件路径规则与 `.env` / `config.json` 一致：绝对路径原样使用，相对路径基于宿主项目根；
 * 只读不写，且错误消息不带文件内容。
 */
describe('Yaml 入口', () => {
    describe('parse / parseAll', () => {
        it('空输入：parse 给 null，parseAll 给空数组', () => {
            assert.equal(Yaml.parse(''), null);
            assert.equal(Yaml.parse('   \n# 只有注释\n'), null);
            assert.deepEqual(Yaml.parseAll(''), []);
        });

        it('单文档：多文档输入时 parse 报错并提示 parseAll', () => {
            assert.deepEqual(Yaml.parse('a: 1\n'), { a: 1 });
            assert.throws(
                () => Yaml.parse('--- 1\n--- 2\n'),
                (error) => error instanceof YamlError
                    && error.kind === 'parse'
                    && error.message.includes('parseAll'),
            );
        });

        it('parseAll：保留文档顺序与空文档', () => {
            assert.deepEqual(Yaml.parseAll('--- 1\n--- {a: 1}\n---\n'), [1, { a: 1 }, null]);
            assert.deepEqual(Yaml.parseAll('---\n...\n'), [null]);
        });

        it('块集合不能与 --- 同行（规范要求块集合另起一行）', () => {
            assert.throws(
                () => Yaml.parseAll('--- a: 1\n'),
                (error) => error instanceof YamlError && error.kind === 'scan',
            );
            assert.deepEqual(Yaml.parseAll('---\na: 1\n'), [{ a: 1 }]);
        });

        it('非字符串输入抛 TypeError', () => {
            assert.throws(() => Yaml.parse(/** @type {any} */ (null)), TypeError);
            assert.throws(() => Yaml.parse(/** @type {any} */ (42)), TypeError);
        });

        it('输入里的 BOM 与 CRLF 都被容忍', () => {
            assert.deepEqual(Yaml.parse('\uFEFFa: 1\r\nb: 2\r\n'), { a: 1, b: 2 });
            assert.deepEqual(Yaml.parse('\uFEFFa: 1'), { a: 1 });
        });
    });

    describe('parseFile / parseFileAll', () => {
        it('相对路径基于宿主项目根解析', () => {
            writeFileSync(join(hostRoot, 'app.yaml'), 'service: demo\nport: 8080\n', 'utf8');
            assert.deepEqual(Yaml.parseFile('app.yaml'), { service: 'demo', port: 8080 });
        });

        it('绝对路径原样使用；UTF-8 BOM 文件可读', () => {
            const file = join(hostRoot, 'bom.yaml');
            writeFileSync(file, '\uFEFFa: 1\n', 'utf8');
            assert.deepEqual(Yaml.parseFile(file), { a: 1 });
        });

        it('多文档文件走 parseFileAll', () => {
            writeFileSync(join(hostRoot, 'multi.yaml'), '--- 1\n--- 2\n', 'utf8');
            assert.deepEqual(Yaml.parseFileAll('multi.yaml'), [1, 2]);
        });

        it('文件不存在：kind=file，消息带路径与 errno，不带内容', () => {
            assert.throws(
                () => Yaml.parseFile('missing.yaml'),
                (error) => error instanceof YamlError
                    && error.kind === 'file'
                    && error.file === join(hostRoot, 'missing.yaml')
                    && error.message.includes('ENOENT'),
            );
        });

        it('UTF-16 文件被明确拒绝（不做静默乱码解析）', () => {
            const file = join(hostRoot, 'utf16.yaml');
            writeFileSync(file, Buffer.from('\uFEFFa: 1\n', 'utf16le'));
            assert.throws(
                () => Yaml.parseFile(file),
                (error) => error instanceof YamlError && error.kind === 'file' && error.message.includes('UTF-16'),
            );
        });

        it('解析错误里带文件名与行列，且不含源文本', () => {
            const file = join(hostRoot, 'broken.yaml');
            writeFileSync(file, 'a: 1\n\tb: 2\n', 'utf8');
            assert.throws(
                () => Yaml.parseFile(file),
                (error) => error instanceof YamlError
                    && error.kind === 'scan'
                    && error.file === file
                    && typeof error.line === 'number'
                    && error.message.includes('第 2 行')
                    && !error.message.includes('b: 2'),
            );
        });

        it('路径参数必须是字符串', () => {
            assert.throws(() => Yaml.parseFile(/** @type {any} */ (null)), TypeError);
            assert.throws(() => Yaml.parseFile(''), TypeError);
        });
    });

    describe('选项校验', () => {
        it('schema / unknownTags / 布尔与整数选项非法时抛 TypeError', () => {
            assert.throws(() => Yaml.parse('a', { schema: 'nope' }), TypeError);
            assert.throws(() => Yaml.parse('a', { unknownTags: 'nope' }), TypeError);
            assert.throws(() => Yaml.parse('a', { uniqueKeys: 'yes' }), TypeError);
            assert.throws(() => Yaml.parse('a', { mergeKeys: 1 }), TypeError);
            assert.throws(() => Yaml.parse('a', { mapAsMap: 1 }), TypeError);
            assert.throws(() => Yaml.parse('a', { intAsBigInt: 1 }), TypeError);
            assert.throws(() => Yaml.parse('a', { maxAliasCount: 1.5 }), TypeError);
            assert.throws(() => Yaml.parse('a', { maxDepth: 0 }), TypeError);
            assert.throws(() => Yaml.parse('a', /** @type {any} */ (null)), TypeError);
        });

        it('选项对象不会被修改', () => {
            const options = { schema: 'json', uniqueKeys: false };
            Yaml.parse('a: 1\n', options);
            assert.deepEqual(options, { schema: 'json', uniqueKeys: false });
        });

        it('schema=json：只认 JSON 类型', () => {
            assert.deepEqual(Yaml.parse('a: 123\nb: true\n', { schema: 'json' }), { a: 123, b: true });
            assert.deepEqual(Yaml.parse('a: ~\n', { schema: 'json' }), { a: '~' });
        });

        it('unknownTags=ignore：本地标签退化为无标签', () => {
            assert.deepEqual(Yaml.parse('a: !custom 1\n', { unknownTags: 'ignore' }), { a: 1 });
            assert.throws(() => Yaml.parse('a: !custom 1\n'), (error) => error instanceof YamlError && error.kind === 'compose');
        });

        it('intAsBigInt：大整数可选 BigInt', () => {
            assert.equal(Yaml.parse('n: 9007199254740993\n').n, 9007199254740992);
            assert.equal(Yaml.parse('n: 9007199254740993\n', { intAsBigInt: true }).n, 9007199254740993n);
        });
    });

    describe('stringify / stringifyAll', () => {
        it('走同一套选项校验', () => {
            assert.equal(Yaml.stringify({ a: 1 }), 'a: 1\n');
            assert.throws(() => Yaml.stringify({}, { indent: 0 }), TypeError);
        });

        it('输出恒以 \\n 结尾', () => {
            for (const value of [null, 'x', 1, [], {}]) {
                assert.equal(Yaml.stringify(value).endsWith('\n'), true);
            }
        });
    });

    it('性能冒烟：2000 键映射在宽裕预算内解析（防意外 O(n²)）', () => {
        const text = `${Array.from({ length: 2000 }, (_, index) => `key${index}: value${index}`).join('\n')}\n`;
        const startedAt = Date.now();
        const value = Yaml.parse(text);
        const elapsed = Date.now() - startedAt;

        assert.equal(Object.keys(value).length, 2000);
        assert.ok(elapsed < 5000, `解析耗时 ${elapsed}ms 超出宽裕预算（5000ms）`);
    });
});
