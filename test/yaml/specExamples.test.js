import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Yaml, YamlError } from '#YukiLib/yaml';
import { SPEC_CASES } from './specCases.js';

/**
 * 规范示例回归
 *
 * 逐条跑规范里的块 / 流 / 标量示例，防止"改一处扫描逻辑，悄悄改掉另一处语义"。
 * 另有一组"本库的显式取舍"用例：规范允许但本库默认拒绝 / 需要选项的形态。
 */
describe('Yaml 规范示例', () => {
    for (const specCase of SPEC_CASES) {
        it(specCase.name, () => {
            const value = specCase.multi === true
                ? Yaml.parseAll(specCase.yaml)
                : Yaml.parse(specCase.yaml);
            assert.deepEqual(value, specCase.expected);
        });
    }

    it('9.5 指令与文档边界：多文档走 parseAll', () => {
        const text = '%YAML 1.2\n---\nfirst\n---\nsecond\n';
        assert.deepEqual(Yaml.parseAll(text), ['first', 'second']);
    });

    it('本库取舍：未知标签默认报错，可显式放开', () => {
        assert.throws(
            () => Yaml.parse('&a !t Example\n'),
            (error) => error instanceof YamlError && error.kind === 'compose',
        );
        assert.equal(Yaml.parse('&a !t Example\n', { unknownTags: 'ignore' }), 'Example');
    });

    it('本库取舍：复杂键需要 mapAsMap', () => {
        const text = '? [Detroit Tigers, Chicago cubs]\n: [2001-07-23]\n';
        assert.throws(() => Yaml.parse(text), (error) => error instanceof YamlError && error.kind === 'construct');
        const map = Yaml.parse(text, { mapAsMap: true });
        assert.deepEqual([...map.values()], [['2001-07-23']]);
    });

    it('本库取舍：YAML 1.1 时间戳需要 yaml11 或显式标签', () => {
        const text = 'Time: 2001-11-23 15:01:42 -5\n';
        assert.deepEqual(Yaml.parse(text), { Time: '2001-11-23 15:01:42 -5' });
        const legacy = Yaml.parse(`%YAML 1.1\n---\n${text}`);
        assert.ok(legacy.Time instanceof Date);
        assert.equal(legacy.Time.toISOString(), '2001-11-23T20:01:42.000Z');
    });

    it('本库取舍：制表符参与缩进一律报错', () => {
        assert.throws(() => Yaml.parse('a:\n\tb: 1\n'), (error) => error instanceof YamlError && error.kind === 'scan');
    });
});
