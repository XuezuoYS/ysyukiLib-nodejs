import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Yaml } from '#YukiLib/yaml/yaml';
import { YamlError } from '#YukiLib/yaml/yamlError';

/**
 * 序列化契约：样式选择、特殊类型、锚点、折行与选项
 *
 * 每条断言都盯着同一个目标——写出来的文本能被 `parse` 回等价值。
 */
describe('Yaml 序列化', () => {
    it('基本类型与空集合', () => {
        assert.equal(Yaml.stringify(null), 'null\n');
        assert.equal(Yaml.stringify(undefined), 'null\n');
        assert.equal(Yaml.stringify(true), 'true\n');
        assert.equal(Yaml.stringify(1), '1\n');
        assert.equal(Yaml.stringify(1.5), '1.5\n');
        assert.equal(Yaml.stringify(10n), '10\n');
        assert.equal(Yaml.stringify(''), "''\n");
        assert.equal(Yaml.stringify([]), '[]\n');
        assert.equal(Yaml.stringify({}), '{}\n');
        assert.equal(Yaml.stringify(new Map()), '!!omap {}\n');
        assert.equal(Yaml.stringify(new Set()), '!!set {}\n');
    });

    it('数字特例：-0 / NaN / ±Infinity', () => {
        assert.equal(Yaml.stringify(-0), '-0.0\n');
        assert.equal(Yaml.stringify(Number.NaN), '.nan\n');
        assert.equal(Yaml.stringify(Number.POSITIVE_INFINITY), '.inf\n');
        assert.equal(Yaml.stringify(Number.NEGATIVE_INFINITY), '-.inf\n');
        assert.ok(Object.is(Yaml.parse('-0.0\n'), -0));
    });

    it('字符串样式：必要才加引号', () => {
        assert.equal(Yaml.stringify('abc'), 'abc\n');
        assert.equal(Yaml.stringify('a b'), 'a b\n');
        assert.equal(Yaml.stringify('-x'), '-x\n');
        assert.equal(Yaml.stringify('true'), "'true'\n");
        assert.equal(Yaml.stringify('123'), "'123'\n");
        assert.equal(Yaml.stringify(''), "''\n");
        assert.equal(Yaml.stringify('a: b'), "'a: b'\n");
        assert.equal(Yaml.stringify('#hash'), "'#hash'\n");
        assert.equal(Yaml.stringify('<<'), "'<<'\n");
        assert.equal(Yaml.stringify('it\'s'), "it's\n");
        assert.equal(Yaml.stringify('a\tb'), '"a\\tb"\n');
        assert.equal(Yaml.stringify('---'), "'---'\n");
        assert.equal(Yaml.stringify('a\nb'), '|-\n  a\n  b\n');
        assert.equal(Yaml.stringify('a\nb\n'), '|\n  a\n  b\n');
        assert.equal(Yaml.stringify('a\n\n'), '|+\n  a\n\n');
        assert.equal(Yaml.stringify('\n'), '"\\n"\n');
        assert.equal(Yaml.stringify(' lead'), "' lead'\n");
        assert.equal(Yaml.stringify('trail '), "'trail '\n");
    });

    it('需要转义的字符：控制字符 / NEL / 行分隔符 / BOM', () => {
        assert.equal(Yaml.stringify('a\u0000b'), '"a\\0b"\n');
        assert.equal(Yaml.stringify('a\u0085b'), '"a\\Nb"\n');
        assert.equal(Yaml.stringify('a\u2028b'), '"a\\Lb"\n');
        assert.equal(Yaml.stringify('a\u2029b'), '"a\\Pb"\n');
        assert.equal(Yaml.stringify('a\u007Fb'), '"a\\x7fb"\n');
        assert.equal(Yaml.stringify('\uFEFF'), '"\\uFEFF"\n');
        assert.equal(Yaml.parse(Yaml.stringify('a\u0085b')), 'a\u0085b');
    });

    it('Date / Buffer / Map / Set / 函数 / symbol', () => {
        assert.equal(Yaml.stringify(new Date('2020-01-02T03:04:05.000Z')), '!!timestamp 2020-01-02T03:04:05.000Z\n');
        assert.equal(Yaml.stringify(Buffer.from('hello')), '!!binary aGVsbG8=\n');
        assert.equal(Yaml.stringify(new Uint8Array([104, 105])), '!!binary aGk=\n');
        assert.equal(Yaml.stringify(new Map([['a', 1]])), '!!omap\na: 1\n');
        assert.equal(Yaml.stringify(new Set(['a'])), '!!set\na: null\n');
        assert.equal(Yaml.stringify(() => 1), 'null\n');
        assert.equal(Yaml.stringify(Symbol('s')), 'null\n');
        assert.throws(
            () => Yaml.stringify({ d: new Date('nope') }),
            (error) => error instanceof YamlError && error.kind === 'stringify' && error.message.includes('$.d'),
        );
    });

    it('嵌套结构：块式缩进与数组项', () => {
        assert.equal(
            Yaml.stringify({ a: 1, b: { c: [1, 2] }, d: null }),
            'a: 1\nb:\n  c:\n    - 1\n    - 2\nd: null\n',
        );
        assert.equal(
            Yaml.stringify([{ a: 1 }, 'x']),
            '- a: 1\n- x\n',
        );
    });

    it('indent 选项（1–9）与非法值', () => {
        assert.equal(Yaml.stringify({ a: { b: 1 } }, { indent: 4 }), 'a:\n    b: 1\n');
        assert.throws(() => Yaml.stringify({}, { indent: 0 }), TypeError);
        assert.throws(() => Yaml.stringify({}, { indent: 10 }), TypeError);
        assert.throws(() => Yaml.stringify({}, { indent: 'x' }), TypeError);
    });

    it('flowLevel：控制哪些层写成流式', () => {
        assert.equal(Yaml.stringify({ a: [1, 2] }, { flowLevel: 0 }), '{ a: [ 1, 2 ] }\n');
        assert.equal(Yaml.stringify({ a: [1, 2] }, { flowLevel: Infinity }), '{ a: [ 1, 2 ] }\n');
        assert.equal(Yaml.stringify([1, 2]), '- 1\n- 2\n');
        // 嵌套更深的集合在较低阈值下仍是块式
        assert.equal(Yaml.stringify({ a: { b: 1 } }, { flowLevel: 0 }), '{ a: { b: 1 } }\n');
    });

    it('lineWidth：流式集合换行与标量折行都不改变语义', () => {
        const long = 'aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd eeeeeeeeee ffffffffff';
        assert.equal(Yaml.parse(Yaml.stringify(long, { lineWidth: 20 })), long);

        const wide = { list: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] };
        const wrapped = Yaml.stringify(wide, { flowLevel: Infinity, lineWidth: 10 });
        assert.ok(wrapped.includes('\n'), '超宽流式集合应换行');
        assert.deepEqual(Yaml.parse(wrapped), wide);
        assert.equal(Yaml.stringify(wide, { flowLevel: Infinity, lineWidth: 0 }).includes('\n'), true);
    });

    it('sortKeys：布尔或比较函数', () => {
        assert.equal(Yaml.stringify({ b: 1, a: 2 }, { sortKeys: true }), 'a: 2\nb: 1\n');
        assert.equal(
            Yaml.stringify({ b: 1, a: 2 }, { sortKeys: (x, y) => (x < y ? 1 : -1) }),
            'b: 1\na: 2\n',
        );
        assert.throws(() => Yaml.stringify({}, { sortKeys: 'x' }), TypeError);
    });

    it('锚点与别名：重复引用默认共享，关闭后各自展开', () => {
        const shared = { a: { n: 1 } };
        shared.b = shared.a;

        const withAlias = Yaml.stringify(shared);
        assert.ok(withAlias.includes('&ref1'));
        assert.ok(withAlias.includes('*ref1'));

        const expanded = Yaml.stringify(shared, { aliasDuplicateObjects: false });
        assert.equal(expanded.includes('&ref'), false);
        assert.deepEqual(Yaml.parse(expanded), { a: { n: 1 }, b: { n: 1 } });
    });

    it('环状结构必须写成锚点，且能读回环', () => {
        /** @type {any} */
        const cyclic = { name: 'root' };
        cyclic.self = cyclic;

        const text = Yaml.stringify(cyclic);
        assert.ok(text.includes('&ref1'));

        const back = Yaml.parse(text);
        assert.equal(back.name, 'root');
        assert.equal(back.self, back);

        // 关闭重复引用别名不影响环状结构的正确性
        const back2 = Yaml.parse(Yaml.stringify(cyclic, { aliasDuplicateObjects: false }));
        assert.equal(back2.self, back2);
    });

    it('长字节串：分块 base64 仍然等值', () => {
        const bytes = Buffer.from('The quick brown fox jumps over the lazy dog. '.repeat(8), 'utf8');
        const text = Yaml.stringify({ blob: bytes }, { lineWidth: 40 });
        assert.ok(text.includes('!!binary |'), '超宽字节串应分块写出');
        assert.equal(text.split('\n').every((line) => line.length <= 45), true);
        assert.equal(Buffer.compare(Yaml.parse(text).blob, bytes), 0);
        assert.equal(Buffer.compare(Yaml.parse(Yaml.stringify(bytes, { lineWidth: 0 })), bytes), 0);
    });

    it('多文档序列化：每个文档以 --- 开头', () => {
        assert.equal(Yaml.stringifyAll([1, { a: 1 }]), '---\n1\n---\na: 1\n');
        assert.deepEqual(Yaml.parseAll(Yaml.stringifyAll([1, { a: 1 }])), [1, { a: 1 }]);
        assert.equal(Yaml.stringifyAll([]), '');
        assert.throws(() => Yaml.stringifyAll(/** @type {any} */ ('x')), TypeError);
    });

    it('多行键与复杂键：走显式键形式', () => {
        const text = Yaml.stringify(new Map([[[1, 2], 'v']]));
        assert.ok(text.includes('?'));
        const back = Yaml.parse(text, { mapAsMap: true });
        assert.equal(back instanceof Map, true);
        assert.deepEqual([...back.values()], ['v']);
    });

    it('Map 的精确键与顺序：非字符串键也能写回 Map', () => {
        const map = new Map(/** @type {Array<[any, any]>} */ ([[2, 'two'], ['1', 'one'], [true, 'yes']]));
        const back = Yaml.parse(Yaml.stringify(map), { mapAsMap: true });
        assert.deepEqual([...back.entries()], [[2, 'two'], ['1', 'one'], [true, 'yes']]);
    });

    it('选项非法一律 TypeError', () => {
        assert.throws(() => Yaml.stringify({}, { lineWidth: -1 }), TypeError);
        assert.throws(() => Yaml.stringify({}, { flowLevel: -2 }), TypeError);
        assert.throws(() => Yaml.stringify({}, { schema: 'nope' }), TypeError);
        assert.throws(() => Yaml.stringify({}, { aliasDuplicateObjects: 'x' }), TypeError);
        assert.throws(() => Yaml.stringify({}, /** @type {any} */ (null)), TypeError);
    });
});
