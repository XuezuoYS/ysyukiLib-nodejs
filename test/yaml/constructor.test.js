import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Yaml } from '#YukiLib/yaml/yaml';
import { YamlError } from '#YukiLib/yaml/yamlError';

/**
 * 合成 + 构造阶段的对外行为（通过公开入口观察）
 *
 * 关注点是"文档形态如何变成 JS 值"：重复键、合并键、原型污染、精确键、
 * `!!set` / `!!omap` / `!!pairs`、标签与节点种类是否匹配。
 */
describe('Yaml 构造（节点图 → JS 值）', () => {
    it('重复键：默认报错，uniqueKeys=false 时后值覆盖', () => {
        assert.throws(
            () => Yaml.parse('a: 1\na: 2\n'),
            (error) => error instanceof YamlError && error.kind === 'construct',
        );
        assert.deepEqual(Yaml.parse('a: 1\na: 2\n', { uniqueKeys: false }), { a: 2 });
    });

    it('键的字符串化：数字 / 布尔 / null / 日期键', () => {
        assert.deepEqual(Yaml.parse('1: a\ntrue: b\nnull: c\n'), { 1: 'a', true: 'b', null: 'c' });
        assert.deepEqual(
            Yaml.parse('%YAML 1.1\n---\n2020-01-02: x\n'),
            { '2020-01-02T00:00:00.000Z': 'x' },
        );
    });

    it('mapAsMap：保留精确键（集合键、NaN 键）', () => {
        const map = Yaml.parse('? [1, 2]\n: v\n', { mapAsMap: true });
        assert.ok(map instanceof Map);
        assert.deepEqual([...map.keys()], [[1, 2]]);
        assert.equal(map.get([1, 2]), undefined); // 键是数组时只能按同一引用取，这里换一个数组当然取不到

        const nan = Yaml.parse('? .nan\n: v\n', { mapAsMap: true });
        assert.equal([...nan.keys()][0], Number.NaN);
    });

    it('普通对象模式遇到复杂键时报错并提示 mapAsMap', () => {
        assert.throws(
            () => Yaml.parse('? [1, 2]\n: v\n'),
            (error) => error instanceof YamlError
                && error.kind === 'construct'
                && error.message.includes('mapAsMap'),
        );
    });

    it('流式映射里的 ":" 规则：`{a:b}` 的键是 "a:b"（符合规范）', () => {
        assert.deepEqual(Yaml.parse('{a:b}\n'), { 'a:b': null });
        assert.deepEqual(Yaml.parse('{a: b}\n'), { a: 'b' });
        assert.deepEqual(Yaml.parse('[a:b]\n'), ['a:b']);
    });

    it('原型污染防护：__proto__ / constructor 只是普通自有属性', () => {
        const value = Yaml.parse('__proto__: {polluted: true}\nconstructor: x\n');
        assert.equal(Object.getPrototypeOf(value), Object.prototype);
        assert.equal(/** @type {any} */ ({}).polluted, undefined);
        assert.equal(Object.prototype.hasOwnProperty.call(value, '__proto__'), true);
        assert.deepEqual(Object.getOwnPropertyDescriptor(value, '__proto__')?.value, { polluted: true });
        assert.equal(value.constructor, 'x');
    });

    it('合并键 <<：映射与映射序列，靠前者优先，显式键覆盖', () => {
        assert.deepEqual(
            Yaml.parse('base: &b {x: 1, y: 2}\nout:\n  <<: *b\n  y: 9\n  z: 3\n'),
            { base: { x: 1, y: 2 }, out: { x: 1, y: 9, z: 3 } },
        );

        assert.deepEqual(
            Yaml.parse('a: &a {x: 1}\nb: &b {x: 2, y: 2}\nout:\n  <<: [*a, *b]\n'),
            { a: { x: 1 }, b: { x: 2, y: 2 }, out: { x: 1, y: 2 } },
        );

        // 合并来源内部的合并也会展开
        assert.deepEqual(
            Yaml.parse('base: &b {x: 1}\nmid: &m\n  <<: *b\n  y: 2\nout:\n  <<: *m\n'),
            { base: { x: 1 }, mid: { x: 1, y: 2 }, out: { x: 1, y: 2 } },
        );
    });

    it('mergeKeys=false 时 << 是普通键', () => {
        assert.deepEqual(
            Yaml.parse('a: &b {x: 1}\nout:\n  <<: *b\n', { mergeKeys: false }),
            { a: { x: 1 }, out: { '<<': { x: 1 } } },
        );
    });

    it('合并键的值必须是映射或映射序列；序列元素也必须是映射', () => {
        assert.throws(() => Yaml.parse('out:\n  <<: 1\n'), (error) => error instanceof YamlError && error.kind === 'construct');
        assert.throws(() => Yaml.parse('out:\n  <<: [1]\n'), (error) => error instanceof YamlError && error.kind === 'construct');
    });

    it('合并键展开条目数也计入 maxAliasCount', () => {
        const text = 'base: &b {a: 1, b: 2, c: 3}\nout:\n  <<: *b\n';
        assert.throws(
            () => Yaml.parse(text, { maxAliasCount: 2 }),
            (error) => error instanceof YamlError && error.kind === 'construct' && error.message.includes('maxAliasCount'),
        );
        assert.deepEqual(Yaml.parse(text, { maxAliasCount: -1 }).out, { a: 1, b: 2, c: 3 });
    });

    it('!!set / !!omap / !!pairs', () => {
        assert.deepEqual([...Yaml.parse('!!set\n? a\n? b\n')], ['a', 'b']);

        const omap = Yaml.parse('!!omap\n- a: 1\n- b: 2\n');
        assert.ok(omap instanceof Map);
        assert.deepEqual([...omap.entries()], [['a', 1], ['b', 2]]);

        assert.deepEqual(Yaml.parse('!!pairs\n- a: 1\n- b: 2\n'), [['a', 1], ['b', 2]]);

        assert.throws(() => Yaml.parse('!!omap\n- a: 1\n- a: 2\n'), (error) => error instanceof YamlError && error.kind === 'construct');
        assert.throws(() => Yaml.parse('!!omap\n- [1, 2]\n'), (error) => error instanceof YamlError && error.kind === 'construct');
    });

    it('标签与节点种类必须匹配', () => {
        assert.throws(() => Yaml.parse('!!str [1]\n'), (error) => error instanceof YamlError && error.kind === 'construct');
        assert.throws(() => Yaml.parse('!!set [1]\n'), (error) => error instanceof YamlError && error.kind === 'construct');
        assert.throws(() => Yaml.parse('!!seq {a: 1}\n'), (error) => error instanceof YamlError && error.kind === 'construct');
    });

    it('别名共享同一个对象引用，环状结构可选中继', () => {
        const value = Yaml.parse('a: &x {n: 1}\nb: *x\n');
        assert.equal(value.a, value.b);

        const cyclic = Yaml.parse('a: &x [1]\na2: *x\n');
        assert.equal(cyclic.a, cyclic.a2);
    });
});
