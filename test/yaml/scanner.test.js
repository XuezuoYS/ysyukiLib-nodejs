import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Scanner, TOKEN } from '#YukiLib/yaml/scanner';
import { YamlError } from '#YukiLib/yaml/yamlError';

/**
 * 标量样式标签
 * @type {Readonly<Record<string, string>>}
 */
const STYLE_LABELS = Object.freeze({
    '': '',
    '\'': 'single ',
    '"': 'double ',
    '|': 'literal ',
    '>': 'folded ',
});

/**
 * 取一段输入的 token 列表
 *
 * @param {string} text 输入
 * @returns {Array<any>} token 列表（含 STREAM_START / STREAM_END）
 */
function tokens(text) {
    const scanner = new Scanner(text);
    /** @type {Array<any>} */
    const list = [];
    for (;;) {
        const token = scanner.getToken();
        if (token === null) {
            break;
        }
        list.push(token);
        if (token.type === TOKEN.STREAM_END) {
            break;
        }
    }
    return list;
}

/**
 * token 列表 → 便于断言的紧凑文本
 *
 * @param {Array<any>} list token 列表
 * @returns {string} 紧凑描述
 */
function compact(list) {
    return list.map((token) => {
        switch (token.type) {
            case TOKEN.SCALAR:
                return `SCALAR(${STYLE_LABELS[token.style]}${JSON.stringify(token.value)})`;
            case TOKEN.ANCHOR:
                return `ANCHOR(${token.value})`;
            case TOKEN.ALIAS:
                return `ALIAS(${token.value})`;
            case TOKEN.TAG:
                return `TAG(${token.handle ?? 'verbatim'}|${token.suffix})`;
            case TOKEN.DIRECTIVE:
                return `DIRECTIVE(${token.name}${token.handle === undefined ? '' : `|${token.handle}|${token.prefix}`})`;
            default:
                return token.type;
        }
    }).join(' ');
}

/**
 * 扫描器：token 级契约
 *
 * 本层只做词法：缩进栈产出块集合起止、简单键在发现 `:` 时回插 KEY（并补 BLOCK_MAPPING_START）、
 * 引号 / 块标量在这里解码、指令与标签在这里成型。
 */
describe('Yaml Scanner', () => {
    it('空输入只产出流开始与结束', () => {
        assert.equal(compact(tokens('')), 'STREAM_START STREAM_END');
        assert.equal(compact(tokens('# 只有注释\n')), 'STREAM_START STREAM_END');
    });

    it('简单映射：KEY 回插在标量之前，块映射开始标记在最前', () => {
        assert.equal(
            compact(tokens('a: 1\n')),
            'STREAM_START BLOCK_MAPPING_START KEY SCALAR("a") VALUE SCALAR("1") BLOCK_END STREAM_END',
        );
    });

    it('块序列与嵌套：缩进栈产出 BLOCK_END', () => {
        assert.equal(
            compact(tokens('- a\n- b\n')),
            'STREAM_START BLOCK_SEQUENCE_START BLOCK_ENTRY SCALAR("a") BLOCK_ENTRY SCALAR("b") BLOCK_END STREAM_END',
        );
        assert.equal(
            compact(tokens('- - a\n')),
            'STREAM_START BLOCK_SEQUENCE_START BLOCK_ENTRY BLOCK_SEQUENCE_START BLOCK_ENTRY SCALAR("a") BLOCK_END BLOCK_END STREAM_END',
        );
    });

    it('缩进式块序列：值列与映射同级时没有 BLOCK_SEQUENCE_START', () => {
        assert.equal(
            compact(tokens('key:\n- 1\n- 2\n')),
            'STREAM_START BLOCK_MAPPING_START KEY SCALAR("key") VALUE BLOCK_ENTRY SCALAR("1") BLOCK_ENTRY SCALAR("2") BLOCK_END STREAM_END',
        );
    });

    it('流式集合与尾部逗号', () => {
        assert.equal(
            compact(tokens('[a, b]')),
            'STREAM_START FLOW_SEQUENCE_START SCALAR("a") FLOW_ENTRY SCALAR("b") FLOW_SEQUENCE_END STREAM_END',
        );
        assert.equal(
            compact(tokens('{a: 1,}')),
            'STREAM_START FLOW_MAPPING_START KEY SCALAR("a") VALUE SCALAR("1") FLOW_ENTRY FLOW_MAPPING_END STREAM_END',
        );
    });

    it('流式里的 ":"：只有跟空白或流式指示符时才是值指示符（`{a:b}` 是一个键）', () => {
        assert.equal(
            compact(tokens('{a:b}')),
            'STREAM_START FLOW_MAPPING_START SCALAR("a:b") FLOW_MAPPING_END STREAM_END',
        );
        assert.equal(
            compact(tokens('{a: b}')),
            'STREAM_START FLOW_MAPPING_START KEY SCALAR("a") VALUE SCALAR("b") FLOW_MAPPING_END STREAM_END',
        );
    });

    it('显式键 ? 与显式值 :', () => {
        assert.equal(
            compact(tokens('? a\n: b\n')),
            'STREAM_START BLOCK_MAPPING_START KEY SCALAR("a") VALUE SCALAR("b") BLOCK_END STREAM_END',
        );
    });

    it('引号标量：转义、折叠、引号内指示符都是内容', () => {
        assert.equal(compact(tokens('"a\\tb"')), 'STREAM_START SCALAR(double ' + JSON.stringify('a\tb') + ') STREAM_END');
        assert.equal(compact(tokens(`'it''s'`)), `STREAM_START SCALAR(single ${JSON.stringify("it's")}) STREAM_END`);
        assert.equal(compact(tokens('"a: b, c"')), `STREAM_START SCALAR(double ${JSON.stringify('a: b, c')}) STREAM_END`);
        assert.equal(compact(tokens('"a\n  b"')), `STREAM_START SCALAR(double ${JSON.stringify('a b')}) STREAM_END`);
        assert.equal(compact(tokens('"a\\\n  b"')), `STREAM_START SCALAR(double ${JSON.stringify('ab')}) STREAM_END`);
    });

    it('块标量：字面 / 折叠 / chomping / 显式缩进指示符', () => {
        const literal = tokens('|\n  a\n  b\n');
        assert.equal(literal[1].style, '|');
        assert.equal(literal[1].value, 'a\nb\n');

        const folded = tokens('>\n  a\n  b\n');
        assert.equal(folded[1].style, '>');
        assert.equal(folded[1].value, 'a b\n');

        assert.equal(tokens('|-\n  a\n')[1].value, 'a');
        assert.equal(tokens('|+\n  a\n\n')[1].value, 'a\n\n');
        assert.equal(tokens('|2\n    a\n')[1].value, '  a\n');
        assert.equal(tokens('>\n  a\n\n  b\n')[1].value, 'a\nb\n');
    });

    it('锚点 / 别名 / 标签', () => {
        assert.equal(compact(tokens('&a 1')), 'STREAM_START ANCHOR(a) SCALAR("1") STREAM_END');
        assert.equal(compact(tokens('*a')), 'STREAM_START ALIAS(a) STREAM_END');
        assert.equal(compact(tokens('!!str 1')), 'STREAM_START TAG(!!|str) SCALAR("1") STREAM_END');
        assert.equal(compact(tokens('!foo 1')), 'STREAM_START TAG(!|foo) SCALAR("1") STREAM_END');
        assert.equal(compact(tokens('!e!x 1')), 'STREAM_START TAG(!e!|x) SCALAR("1") STREAM_END');
        assert.equal(
            compact(tokens('!<tag:example.com,2000:x> 1')),
            'STREAM_START TAG(verbatim|tag:example.com,2000:x) SCALAR("1") STREAM_END',
        );
    });

    it('指令：%YAML 与 %TAG', () => {
        assert.equal(
            compact(tokens('%YAML 1.2\n---\na\n')),
            'STREAM_START DIRECTIVE(YAML) DOCUMENT_START SCALAR("a") STREAM_END',
        );

        const tagList = tokens('%TAG !e! tag:example.com,2000:\n---\n!e!x 1\n');
        assert.equal(tagList[1].type, TOKEN.DIRECTIVE);
        assert.equal(tagList[1].prefix, 'tag:example.com,2000:');
        assert.equal(tagList[1].handle, '!e!');

        // 保留指令按规范忽略
        assert.equal(
            compact(tokens('%FOO bar\n---\na\n')),
            'STREAM_START DIRECTIVE(FOO) DOCUMENT_START SCALAR("a") STREAM_END',
        );
    });

    it('文档标记：--- 与 ...，以及 plain 标量在标记前结束', () => {
        assert.equal(
            compact(tokens('--- a\n...\n')),
            'STREAM_START DOCUMENT_START SCALAR("a") DOCUMENT_END STREAM_END',
        );
        assert.equal(
            compact(tokens('a\n--- b\n')),
            'STREAM_START SCALAR("a") DOCUMENT_START SCALAR("b") STREAM_END',
        );
    });

    it('注释与行尾空白被跳过；跨行 plain 标量折叠成空格', () => {
        assert.equal(
            compact(tokens('a: 1 # 注释\n# 整行注释\nb: 2\n')),
            'STREAM_START BLOCK_MAPPING_START KEY SCALAR("a") VALUE SCALAR("1") KEY SCALAR("b") VALUE SCALAR("2") BLOCK_END STREAM_END',
        );
        assert.equal(compact(tokens('a\nb\n')), 'STREAM_START SCALAR("a b") STREAM_END');
    });

    describe('扫描错误', () => {
        it('块上下文用制表符做缩进', () => {
            assert.throws(
                () => tokens('\ta: 1\n'),
                (error) => error instanceof YamlError && error.kind === 'scan' && error.line === 1,
            );
        });

        it('未结束的引号', () => {
            assert.throws(() => tokens('"abc'), (error) => error instanceof YamlError && error.kind === 'scan');
            assert.throws(() => tokens("'abc"), (error) => error instanceof YamlError && error.kind === 'scan');
        });

        it('未知转义与不完整十六进制转义', () => {
            assert.throws(() => tokens('"\\q"'), (error) => error instanceof YamlError && error.kind === 'scan');
            assert.throws(() => tokens('"\\x1"'), (error) => error instanceof YamlError && error.kind === 'scan');
        });

        it('块标量缩进指示符为 0', () => {
            assert.throws(() => tokens('|0\n  a\n'), (error) => error instanceof YamlError && error.kind === 'scan');
        });

        it('指令：版本号非法 / 主版本不支持 / 重复 %YAML / 指令后有多余内容', () => {
            assert.throws(() => tokens('%YAML 1\n---\n'), (error) => error instanceof YamlError && error.kind === 'scan');
            assert.throws(() => tokens('%YAML 2.0\n---\n'), (error) => error instanceof YamlError && error.kind === 'scan');
            assert.throws(() => tokens('%YAML 1.2\n%YAML 1.2\n---\n'), (error) => error instanceof YamlError && error.kind === 'scan');
            assert.throws(() => tokens('%YAML 1.2 x\n---\n'), (error) => error instanceof YamlError && error.kind === 'scan');
        });

        it('重复声明同一个 %TAG 句柄', () => {
            assert.throws(
                () => tokens('%TAG !e! a\n%TAG !e! b\n---\n'),
                (error) => error instanceof YamlError && error.kind === 'scan',
            );
        });

        it('块上下文里以流式指示符开头、或多余的结束括号', () => {
            // `,` 出现在块上下文的行首：plain 标量不能以指示符开头
            assert.throws(() => tokens(','), (error) => error instanceof YamlError && error.kind === 'scan');
            assert.throws(() => tokens(']'), (error) => error instanceof YamlError && error.kind === 'scan');
            assert.throws(() => tokens('{}]'), (error) => error instanceof YamlError && error.kind === 'scan');
            assert.throws(() => tokens('[1]]'), (error) => error instanceof YamlError && error.kind === 'scan');
            // 块上下文里 `,` 出现在行内不是错误：它是 plain 标量的一部分
            assert.equal(compact(tokens('a, b')), 'STREAM_START SCALAR("a, b") STREAM_END');
        });

        it('块映射里必需的简单键没等到 ":"', () => {
            assert.throws(
                () => tokens('a: 1\nb\n'),
                (error) => error instanceof YamlError && error.kind === 'scan',
            );
        });

        it('未知的起始字符', () => {
            assert.throws(() => tokens('@x'), (error) => error instanceof YamlError && error.kind === 'scan');
            assert.throws(() => tokens('`x`'), (error) => error instanceof YamlError && error.kind === 'scan');
        });
    });
});
