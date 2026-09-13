import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Parser } from '#YukiLib/yaml/parser';
import { YamlError } from '#YukiLib/yaml/yamlError';

/**
 * 取一段输入的 event 列表（紧凑文本形式）
 *
 * @param {string} text 输入
 * @param {Record<string, any>} [options] 解析选项
 * @returns {string} 紧凑描述
 */
function events(text, options = {}) {
    return new Parser(text, options).events().map((event) => {
        switch (event.type) {
            case 'SCALAR':
                return `SCALAR${event.style === '' ? '' : `[${event.style}]`}(${JSON.stringify(event.value)})`;
            case 'ALIAS':
                return `ALIAS(${event.anchor})`;
            case 'SEQUENCE_START':
                return `SEQUENCE_START${event.flow ? '(flow)' : ''}${event.anchor ? `(${event.anchor})` : ''}`;
            case 'MAPPING_START':
                return `MAPPING_START${event.flow ? '(flow)' : ''}${event.anchor ? `(${event.anchor})` : ''}`;
            default:
                return event.type;
        }
    }).join(' ');
}

/**
 * 解析器：token → event
 *
 * 事件流与规范的产生式对应；文档边界（`---` / `...`）、空节点、显式键、
 * 流式里的隐式单键映射都在这一层成形。
 */
describe('Yaml Parser', () => {
    it('空输入只有流边界；空文档仍是一个文档', () => {
        assert.equal(events(''), 'STREAM_START STREAM_END');
        assert.equal(events('---\n'), 'STREAM_START DOCUMENT_START SCALAR("") DOCUMENT_END STREAM_END');
        assert.equal(events('---\n---\n'), 'STREAM_START DOCUMENT_START SCALAR("") DOCUMENT_END DOCUMENT_START SCALAR("") DOCUMENT_END STREAM_END');
    });

    it('多文档与文档结束标记', () => {
        assert.equal(
            events('--- a\n--- b\n...\n'),
            'STREAM_START DOCUMENT_START SCALAR("a") DOCUMENT_END DOCUMENT_START SCALAR("b") DOCUMENT_END STREAM_END',
        );
    });

    it('映射 / 序列 / 空值的空节点', () => {
        assert.equal(
            events('a:\nb: 1\n'),
            'STREAM_START DOCUMENT_START MAPPING_START SCALAR("a") SCALAR("") SCALAR("b") SCALAR("1") MAPPING_END DOCUMENT_END STREAM_END',
        );
        assert.equal(
            events('- \n- 1\n'),
            'STREAM_START DOCUMENT_START SEQUENCE_START SCALAR("") SCALAR("1") SEQUENCE_END DOCUMENT_END STREAM_END',
        );
    });

    it('缩进式块序列（indentless）', () => {
        assert.equal(
            events('key:\n- 1\n- 2\n'),
            'STREAM_START DOCUMENT_START MAPPING_START SCALAR("key") SEQUENCE_START SCALAR("1") SCALAR("2") SEQUENCE_END MAPPING_END DOCUMENT_END STREAM_END',
        );
    });

    it('流式序列 / 映射与尾部逗号', () => {
        assert.equal(
            events('[1, 2,]\n'),
            'STREAM_START DOCUMENT_START SEQUENCE_START(flow) SCALAR("1") SCALAR("2") SEQUENCE_END DOCUMENT_END STREAM_END',
        );
        assert.equal(
            events('{a: 1,}\n'),
            'STREAM_START DOCUMENT_START MAPPING_START(flow) SCALAR("a") SCALAR("1") MAPPING_END DOCUMENT_END STREAM_END',
        );
    });

    it('流式序列里的单键映射：`[a: b]` 等于 `[{a: b}]`', () => {
        assert.equal(
            events('[a: 1, b: 2]\n'),
            'STREAM_START DOCUMENT_START SEQUENCE_START(flow) MAPPING_START(flow) SCALAR("a") SCALAR("1") MAPPING_END'
                + ' MAPPING_START(flow) SCALAR("b") SCALAR("2") MAPPING_END SEQUENCE_END DOCUMENT_END STREAM_END',
        );
    });

    it('流式映射的空键与空值', () => {
        assert.equal(
            events('{: 1, a:, b}\n'),
            'STREAM_START DOCUMENT_START MAPPING_START(flow) SCALAR("") SCALAR("1") SCALAR("a") SCALAR("") SCALAR("b") SCALAR("") MAPPING_END DOCUMENT_END STREAM_END',
        );
    });

    it('显式键与复杂键', () => {
        assert.equal(
            events('? [1, 2]\n: v\n'),
            'STREAM_START DOCUMENT_START MAPPING_START SEQUENCE_START(flow) SCALAR("1") SCALAR("2") SEQUENCE_END SCALAR("v") MAPPING_END DOCUMENT_END STREAM_END',
        );
    });

    it('锚点 / 别名 / 标签挂在对应节点上', () => {
        assert.equal(
            events('a: &x !str v\nb: *x\n'),
            'STREAM_START DOCUMENT_START MAPPING_START SCALAR("a") SCALAR("v") SCALAR("b") ALIAS(x) MAPPING_END DOCUMENT_END STREAM_END',
        );
    });

    it('只有属性没有内容：按空节点处理', () => {
        assert.equal(events('!\n'), 'STREAM_START DOCUMENT_START SCALAR("") DOCUMENT_END STREAM_END');
        assert.equal(events('!!str\n'), 'STREAM_START DOCUMENT_START SCALAR("") DOCUMENT_END STREAM_END');
        assert.equal(events('&a\n'), 'STREAM_START DOCUMENT_START SCALAR("") DOCUMENT_END STREAM_END');
    });

    it('块标量样式在事件里保留', () => {
        assert.equal(
            events('a: |\n  x\n'),
            'STREAM_START DOCUMENT_START MAPPING_START SCALAR("a") SCALAR[|]("x\\n") MAPPING_END DOCUMENT_END STREAM_END',
        );
    });

    describe('解析错误', () => {
        it('指令之后必须紧跟 ---', () => {
            assert.throws(
                () => events('%YAML 1.2\na\n'),
                (error) => error instanceof YamlError && error.kind === 'parse',
            );
        });

        it('第一个文档之后必须显式 --- 分隔', () => {
            assert.throws(
                () => events('a\n...\nb\n'),
                (error) => error instanceof YamlError && error.kind === 'parse',
            );
        });

        it('标签重复或锚点重复', () => {
            assert.throws(() => events('!!str !!int 1\n'), (error) => error instanceof YamlError && error.kind === 'parse');
            assert.throws(() => events('&a &b 1\n'), (error) => error instanceof YamlError && error.kind === 'parse');
        });

        it('别名节点不能带属性', () => {
            assert.throws(() => events('&a *b\n'), (error) => error instanceof YamlError && error.kind === 'parse');
        });

        it('嵌套深度超过 maxDepth', () => {
            const deep = `${'- '.repeat(40)}x\n`;
            assert.throws(
                () => events(deep, { maxDepth: 8 }),
                (error) => error instanceof YamlError && error.kind === 'parse' && error.message.includes('maxDepth'),
            );
        });
    });
});
