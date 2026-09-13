import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Reader } from '#YukiLib/yaml/reader';
import { YamlError } from '#YukiLib/yaml/yamlError';

/**
 * 字符流层：BOM / 换行归一、位置（列 0 起）、可打印字符校验
 *
 * 列号在这里刻意是 **0 起**（与规范的行内列号一致），对外错误里才 +1；
 * 位置按归一化后的文本计，因此 CRLF 只算一个换行。
 */
describe('Yaml Reader', () => {
    it('剔除流首 UTF-8 BOM', () => {
        const reader = new Reader('\uFEFFa: 1');
        assert.equal(reader.peek(), 'a');
        assert.equal(reader.column, 0);

        // BOM 之后的内容照常计数（BOM 本身不占列）
        assert.equal(reader.peek(1), ':');
    });

    it('换行归一：CRLF / CR / NEL / LS / PS 都算一个 \\n', () => {
        for (const text of ['a\r\nb', 'a\rb', 'a\u0085b', 'a\u2028b', 'a\u2029b']) {
            const reader = new Reader(text);
            reader.forward();
            assert.equal(reader.peek(), '\n', JSON.stringify(text));
            assert.equal(reader.line, 1);
            assert.equal(reader.column, 1);
            reader.forward();
            assert.equal(reader.line, 2);
            assert.equal(reader.column, 0);
            assert.equal(reader.peek(), 'b');
        }
    });

    it('peek 越界返回空串，eof 反映流结束', () => {
        const reader = new Reader('ab');
        assert.equal(reader.eof(), false);
        reader.forward(2);
        assert.equal(reader.eof(), true);
        assert.equal(reader.peek(), '');
        assert.equal(reader.peek(5), '');
        // 越界前进不改变位置
        reader.forward(3);
        assert.equal(reader.index, 2);
    });

    it('mark 与 slice 给出准确位置与片段', () => {
        const reader = new Reader('one\ntwo\n');
        reader.forward(4);
        const mark = reader.mark();
        assert.deepEqual(mark, { index: 4, line: 2, column: 0 });
        assert.equal(reader.slice(0, 3), 'one');
        assert.equal(reader.slice(4, 7), 'two');
    });

    it('非法控制字符在读取阶段报错（kind=stream），并给出 1 起的列号', () => {
        assert.throws(
            () => new Reader('a\u0001b'),
            (error) => error instanceof YamlError
                && error.kind === 'stream'
                && error.line === 1
                && error.column === 2
                && error.message.includes('第 1 行第 2 列'),
        );
    });

    it('孤立代理项同样拒绝', () => {
        assert.throws(
            () => new Reader(`a${String.fromCharCode(0xD800)}b`),
            (error) => error instanceof YamlError && error.kind === 'stream',
        );
    });

    it('制表符与代理对是合法内容（peek 按 UTF-16 码元返回）', () => {
        const reader = new Reader('a\tb😀');
        reader.forward(3);
        assert.equal(reader.peek(), '\uD83D');
        assert.equal(reader.peek(1), '\uDE00');
        reader.forward(2);
        assert.equal(reader.eof(), true);
    });

    it('非字符串输入抛 TypeError（不是 YamlError）', () => {
        assert.throws(() => new Reader(/** @type {any} */ (null)), TypeError);
        assert.throws(() => new Reader(/** @type {any} */ (Buffer.from('a'))), TypeError);
    });
});
