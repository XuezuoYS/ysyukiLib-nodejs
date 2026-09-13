import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    TAG,
    constructScalarValue,
    parseTimestamp,
    resolvePlainTag,
    resolveTagReference,
    wouldResolveAsNonString,
} from '#YukiLib/yaml/schema';
import { YamlError } from '#YukiLib/yaml/yamlError';

/**
 * 标签与类型推断
 *
 * 只有 plain 标量参与隐式推断；四张表（failsafe / json / core / yaml11）与显式标签构造
 * 是"读"与"写"共用的真值表（stringify 也调 `wouldResolveAsNonString`）。
 */
describe('Yaml Schema', () => {
    it('core（默认）：null / bool / int / float，其余为字符串', () => {
        assert.equal(resolvePlainTag('~', 'core'), TAG.NULL);
        assert.equal(resolvePlainTag('null', 'core'), TAG.NULL);
        assert.equal(resolvePlainTag('NULL', 'core'), TAG.NULL);
        assert.equal(resolvePlainTag('', 'core'), TAG.NULL);
        assert.equal(resolvePlainTag('true', 'core'), TAG.BOOL);
        assert.equal(resolvePlainTag('False', 'core'), TAG.BOOL);
        assert.equal(resolvePlainTag('yes', 'core'), TAG.STR);
        assert.equal(resolvePlainTag('on', 'core'), TAG.STR);
        assert.equal(resolvePlainTag('123', 'core'), TAG.INT);
        assert.equal(resolvePlainTag('-0', 'core'), TAG.INT);
        assert.equal(resolvePlainTag('0o17', 'core'), TAG.INT);
        assert.equal(resolvePlainTag('0xF', 'core'), TAG.INT);
        assert.equal(resolvePlainTag('1.5', 'core'), TAG.FLOAT);
        assert.equal(resolvePlainTag('.inf', 'core'), TAG.FLOAT);
        assert.equal(resolvePlainTag('-.inf', 'core'), TAG.FLOAT);
        assert.equal(resolvePlainTag('.nan', 'core'), TAG.FLOAT);
        assert.equal(resolvePlainTag('1e3', 'core'), TAG.FLOAT);
        assert.equal(resolvePlainTag('2020-01-02', 'core'), TAG.STR);
        assert.equal(resolvePlainTag('010', 'core'), TAG.INT);
        assert.equal(resolvePlainTag('1_000', 'core'), TAG.STR);
    });

    it('failsafe：一切皆字符串（空节点除外）', () => {
        assert.equal(resolvePlainTag('123', 'failsafe'), TAG.STR);
        assert.equal(resolvePlainTag('true', 'failsafe'), TAG.STR);
        assert.equal(resolvePlainTag('~', 'failsafe'), TAG.STR);
    });

    it('json：只认 JSON 能表达的形态', () => {
        assert.equal(resolvePlainTag('null', 'json'), TAG.NULL);
        assert.equal(resolvePlainTag('~', 'json'), TAG.STR);
        assert.equal(resolvePlainTag('TRUE', 'json'), TAG.STR);
        assert.equal(resolvePlainTag('+1', 'json'), TAG.STR);
        assert.equal(resolvePlainTag('1', 'json'), TAG.INT);
        assert.equal(resolvePlainTag('1.5', 'json'), TAG.FLOAT);
        assert.equal(resolvePlainTag('1e3', 'json'), TAG.FLOAT);
        assert.equal(resolvePlainTag('.inf', 'json'), TAG.STR);
    });

    it('yaml11：yes/no/on/off、0NNN 八进制、0b、下划线、sexagesimal、时间戳', () => {
        assert.equal(resolvePlainTag('yes', 'yaml11'), TAG.BOOL);
        assert.equal(resolvePlainTag('Off', 'yaml11'), TAG.BOOL);
        assert.equal(resolvePlainTag('010', 'yaml11'), TAG.INT);
        assert.equal(resolvePlainTag('0b101', 'yaml11'), TAG.INT);
        assert.equal(resolvePlainTag('1_000', 'yaml11'), TAG.INT);
        assert.equal(resolvePlainTag('12:30', 'yaml11'), TAG.INT);
        assert.equal(resolvePlainTag('2020-01-02', 'yaml11'), TAG.TIMESTAMP);
        assert.equal(resolvePlainTag('y', 'yaml11'), TAG.STR);
    });

    it('wouldResolveAsNonString 与隐式标签同源', () => {
        assert.equal(wouldResolveAsNonString('123', 'core'), true);
        assert.equal(wouldResolveAsNonString('123', 'failsafe'), false);
        assert.equal(wouldResolveAsNonString('abc', 'core'), false);
        assert.equal(wouldResolveAsNonString('yes', 'yaml11'), true);
    });

    it('resolveTagReference：verbatim / 简写 / 自定义句柄 / 非特定 !', () => {
        assert.equal(resolveTagReference(null, 'tag:example.com,2000:x', new Map()), 'tag:example.com,2000:x');
        assert.equal(resolveTagReference('!!', 'str', new Map()), TAG.STR);
        assert.equal(resolveTagReference('!', 'foo', new Map()), '!foo');
        assert.equal(resolveTagReference('!', '', new Map()), '!');
        assert.equal(
            resolveTagReference('!e!', 'x', new Map([['!e!', 'tag:example.com,2000:']])),
            'tag:example.com,2000:x',
        );
    });

    describe('constructScalarValue', () => {
        it('字符串 / null / bool', () => {
            assert.equal(constructScalarValue('abc', TAG.STR), 'abc');
            assert.equal(constructScalarValue('~', TAG.NULL), null);
            assert.equal(constructScalarValue('true', TAG.BOOL), true);
            assert.equal(constructScalarValue('no', TAG.BOOL), false);
            assert.throws(() => constructScalarValue('maybe', TAG.BOOL), (error) => error instanceof YamlError && error.kind === 'construct');
        });

        it('整数：十进制 / 十六进制 / 八进制 / 二进制 / sexagesimal / 下划线', () => {
            assert.equal(constructScalarValue('123', TAG.INT), 123);
            assert.equal(constructScalarValue('-7', TAG.INT), -7);
            assert.equal(constructScalarValue('0x1F', TAG.INT), 31);
            assert.equal(constructScalarValue('0o17', TAG.INT), 15);
            assert.equal(constructScalarValue('017', TAG.INT), 15);
            assert.equal(constructScalarValue('0b101', TAG.INT), 5);
            assert.equal(constructScalarValue('1_000', TAG.INT), 1000);
            assert.equal(constructScalarValue('12:30', TAG.INT), 750);
            assert.throws(() => constructScalarValue('1.5', TAG.INT), (error) => error instanceof YamlError && error.kind === 'construct');
            assert.throws(() => constructScalarValue('0x', TAG.INT), (error) => error instanceof YamlError && error.kind === 'construct');
        });

        it('intAsBigInt：超出安全整数范围时给 BigInt', () => {
            const big = '9007199254740993';
            assert.equal(constructScalarValue(big, TAG.INT), Number(big));
            assert.equal(constructScalarValue(big, TAG.INT, { intAsBigInt: true }), 9007199254740993n);
            assert.equal(constructScalarValue('1', TAG.INT, { intAsBigInt: true }), 1);
        });

        it('浮点：普通 / 指数 / .inf / .nan / sexagesimal', () => {
            assert.equal(constructScalarValue('1.5', TAG.FLOAT), 1.5);
            assert.equal(constructScalarValue('1e3', TAG.FLOAT), 1000);
            assert.equal(constructScalarValue('.inf', TAG.FLOAT), Number.POSITIVE_INFINITY);
            assert.equal(constructScalarValue('-.inf', TAG.FLOAT), Number.NEGATIVE_INFINITY);
            assert.ok(Number.isNaN(constructScalarValue('.nan', TAG.FLOAT)));
            assert.equal(constructScalarValue('1:30.5', TAG.FLOAT), 90.5);
        });

        it('!!binary：base64（容忍折行与空白），非法输入报错', () => {
            assert.equal(constructScalarValue('aGVsbG8=', TAG.BINARY).toString(), 'hello');
            assert.equal(constructScalarValue('aGVs\n bG8=', TAG.BINARY).toString(), 'hello');
            assert.equal(constructScalarValue('', TAG.BINARY).length, 0);
            assert.throws(() => constructScalarValue('a', TAG.BINARY), (error) => error instanceof YamlError && error.kind === 'construct');
            assert.throws(() => constructScalarValue('####', TAG.BINARY), (error) => error instanceof YamlError && error.kind === 'construct');
        });

        it('!!timestamp：日期（UTC）/ 带时区 / 本地时间 / 非法值', () => {
            assert.equal(
                constructScalarValue('2020-01-02', TAG.TIMESTAMP).toISOString(),
                '2020-01-02T00:00:00.000Z',
            );
            assert.equal(
                constructScalarValue('2020-01-02T03:04:05.678Z', TAG.TIMESTAMP).toISOString(),
                '2020-01-02T03:04:05.678Z',
            );
            assert.equal(
                constructScalarValue('2020-01-02T03:04:05+02:00', TAG.TIMESTAMP).toISOString(),
                '2020-01-02T01:04:05.000Z',
            );
            assert.throws(() => constructScalarValue('2020-13-40', TAG.TIMESTAMP), (error) => error instanceof YamlError && error.kind === 'construct');
            assert.throws(() => constructScalarValue('nope', TAG.TIMESTAMP), (error) => error instanceof YamlError && error.kind === 'construct');
        });

        it('parseTimestamp 直接调用：未匹配返回 null', () => {
            assert.equal(parseTimestamp('nope'), null);
            assert.equal(parseTimestamp('2020-02-30'), null);
            assert.equal(parseTimestamp('2020-01-02T25:00:00Z'), null);
            assert.ok(parseTimestamp('2020-01-02T03:04:05') instanceof Date);
        });

        it('未知标签在这里直接报错（调用方负责策略）', () => {
            assert.throws(
                () => constructScalarValue('1', 'tag:example.com,2000:x'),
                (error) => error instanceof YamlError && error.kind === 'construct',
            );
        });
    });
});
