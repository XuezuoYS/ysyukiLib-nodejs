import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Yaml } from '#YukiLib/yaml';

/**
 * round-trip：`parse(stringify(v))` 与 v 等值
 *
 * 这是"写"的可信度来源：只要这一个方向成立，序列化就不会悄悄改变数据的含义。
 * 有下列**已知例外**（都写在 docs/yaml.md，不在语料里当作等值断言）：
 * - `undefined` / 函数 / `symbol` → 写出为 `null`；
 * - `Map` / `Set` / `Date` / `Buffer` 需要靠显式标签才能回原类型，已在专项用例里覆盖；
 * - 对象里值为 `undefined` 的键会被写为 `null`（不会丢键）。
 */
describe('Yaml round-trip', () => {
    const scalars = [
        null,
        true,
        false,
        0,
        1,
        -1,
        1.5,
        -1.5,
        1e21,
        -1e-7,
        Number.MAX_SAFE_INTEGER,
        '',
        'plain',
        'a b',
        ' leading',
        'trailing ',
        'true',
        'null',
        '~',
        '123',
        '1.5',
        '.inf',
        'yes',
        'on',
        '-x',
        '?x',
        ':x',
        '#hash',
        'a: b',
        'a #b',
        '---',
        '...',
        '<<',
        'a\nb',
        'a\nb\n',
        'a\n\n',
        '\n',
        '\n\n',
        'line\n  deeper\nline',
        "it's",
        'quote " inside',
        'back\\slash',
        'tab\there',
        'ctrl\u0001char',
        'nel\u0085char',
        'ls\u2028char',
        'emoji 😀',
        '中文键值',
        '[brackets]',
        '{braces}',
        'comma, separated',
        '%percent',
        '@at',
        '`backtick`',
        '|pipe',
        '>gt',
        '&amp',
        '*star',
        '!bang',
        'spaces   inside',
    ];

    for (const value of scalars) {
        it(`标量 ${JSON.stringify(value)}`, () => {
            const text = Yaml.stringify(value);
            assert.deepEqual(Yaml.parse(text), value);
        });
    }

    it('BigInt 写出为整数字面量；读回类型由 intAsBigInt 决定（已知例外）', () => {
        assert.equal(Yaml.stringify(10n), '10\n');
        assert.equal(Yaml.parse(Yaml.stringify(10n)), 10);
        // intAsBigInt 只在"超出安全整数范围"时生效，与 yaml 库的语义一致
        assert.equal(Yaml.parse(Yaml.stringify(10n), { intAsBigInt: true }), 10);
        assert.equal(Yaml.parse(Yaml.stringify(2n ** 80n)), Number(2n ** 80n));
        assert.equal(Yaml.parse(Yaml.stringify(2n ** 80n), { intAsBigInt: true }), 2n ** 80n);
    });

    it('嵌套集合语料', () => {
        const value = {
            service: 'demo',
            port: 8080,
            debug: false,
            extra: null,
            tags: ['a', 'b c', 'true', 3],
            nested: {
                deep: {
                    list: [[1, 2], [3, 4]],
                    empty: {},
                    emptyList: [],
                    text: 'multi\nline\ntext\n',
                },
            },
            tricky: {
                'key: colon': 1,
                'true': 2,
                '#hash': 3,
                '': 4,
                'multi\nline key': 5,
            },
        };
        assert.deepEqual(Yaml.parse(Yaml.stringify(value)), value);
    });

    it('键与值都需要引号时不改变含义', () => {
        const value = { '1': 'one', 'true': 'yes', 'null': 'nil', 'a: b': 'c: d' };
        assert.deepEqual(Yaml.parse(Yaml.stringify(value)), value);
    });

    it('长字符串与折行组合仍等值', () => {
        const words = Array.from({ length: 60 }, (_, index) => `word${index}`).join(' ');
        const value = { text: words, quoted: `a: ${words}`, single: `it's ${words}` };
        for (const lineWidth of [0, 20, 40, 80]) {
            assert.deepEqual(Yaml.parse(Yaml.stringify(value, { lineWidth })), value);
        }
    });

    it('不同缩进与流式层级下仍等值', () => {
        const value = { a: { b: { c: [1, { d: 'x' }] } } };
        for (const indent of [1, 2, 4, 9]) {
            for (const flowLevel of [-1, 0, 1, 3, Infinity]) {
                assert.deepEqual(
                    Yaml.parse(Yaml.stringify(value, { indent, flowLevel })),
                    value,
                    `indent=${indent} flowLevel=${flowLevel}`,
                );
            }
        }
    });

    it('显式标签类型（Date / Buffer / Map / Set）可回原类型', () => {
        const value = {
            at: new Date('2020-01-02T03:04:05.678Z'),
            bytes: Buffer.from('hello'),
            dictionary: new Map([['a', 1], ['b', 2]]),
            unique: new Set(['x', 'y']),
        };
        const back = Yaml.parse(Yaml.stringify(value));
        assert.ok(back.at instanceof Date);
        assert.equal(back.at.toISOString(), '2020-01-02T03:04:05.678Z');
        assert.equal(Buffer.compare(back.bytes, value.bytes), 0);
        assert.ok(back.dictionary instanceof Map);
        assert.deepEqual([...back.dictionary.entries()], [['a', 1], ['b', 2]]);
        assert.ok(back.unique instanceof Set);
        assert.deepEqual([...back.unique], ['x', 'y']);
    });

    it('重复引用与环状结构：共享关系在读写后保持', () => {
        /** @type {any} */
        const value = { shared: { n: 1 }, a: null, b: null };
        value.a = value.shared;
        value.b = value.shared;

        const back = Yaml.parse(Yaml.stringify(value));
        assert.equal(back.a, back.shared);
        assert.equal(back.b, back.shared);

        /** @type {any} */
        const cyclic = { name: 'root', list: [] };
        cyclic.list.push(cyclic);
        const backCyclic = Yaml.parse(Yaml.stringify(cyclic));
        assert.equal(backCyclic.list[0], backCyclic);
    });
});
