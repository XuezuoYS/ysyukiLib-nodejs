import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { composeDocument, schemaForDocument } from '#YukiLib/yaml/composer';
import { normalizeParseOptions } from '#YukiLib/yaml/options';
import { Parser } from '#YukiLib/yaml/parser';
import { TAG } from '#YukiLib/yaml/schema';
import { YamlError } from '#YukiLib/yaml/yamlError';

/**
 * 合成一个文档的节点图
 *
 * @param {string} text 输入
 * @param {Record<string, any>} [options] 解析选项
 * @returns {any} 根节点
 */
function compose(text, options = {}) {
    const normalized = normalizeParseOptions(options);
    const documents = new Parser(text, normalized).documents();
    assert.equal(documents.length >= 1, true, '测试输入至少应有一个文档');
    return composeDocument(documents[0], normalized);
}

/**
 * 合成器：event → 节点图
 *
 * 这里定下"扩成什么类型、指向哪个锚点"：锚点先登记后解析子节点，因此自引用成立；
 * 标签在这里按 `%TAG` 句柄表展开；未知标签按策略处理（默认报错）。
 */
describe('Yaml Composer', () => {
    it('标量：plain 参与隐式解析，引号 / 块标量恒为字符串', () => {
        assert.equal(compose('a: 1\n').entries[0].value.tag, TAG.INT);
        assert.equal(compose('a: "1"\n').entries[0].value.tag, TAG.STR);
        assert.equal(compose("a: '1'\n").entries[0].value.tag, TAG.STR);
        assert.equal(compose('a: |\n  1\n').entries[0].value.tag, TAG.STR);
        assert.equal(compose('a: null\n').entries[0].value.tag, TAG.NULL);
        assert.equal(compose('a:\n').entries[0].value.tag, TAG.NULL);
    });

    it('显式标签：简写、verbatim、非特定 !', () => {
        assert.equal(compose('x: !!str 1\n').entries[0].value.tag, TAG.STR);
        assert.equal(compose('x: !!int "1"\n').entries[0].value.tag, TAG.INT);
        assert.equal(compose('x: !<tag:yaml.org,2002:float> 1\n').entries[0].value.tag, TAG.FLOAT);
        assert.equal(compose('x: ! 1\n').entries[0].value.tag, TAG.STR);
        assert.equal(compose('! [1]\n').tag, TAG.SEQ);
    });

    it('%TAG 句柄表按文档生效', () => {
        const document = new Parser('%TAG !e! tag:yaml.org,2002:\n---\n!e!str 1\n', normalizeParseOptions({}))
            .documents()[0];
        const node = composeDocument(document, normalizeParseOptions({}));
        assert.equal(node.tag, TAG.STR);
    });

    it('未声明的句柄按本地标签处理，默认报错；ignore 时退化为无标签', () => {
        assert.throws(
            () => compose('x: !e!y 1\n'),
            (error) => error instanceof YamlError && error.kind === 'compose',
        );
        const relaxed = compose('x: !e!y 1\n', { unknownTags: 'ignore' });
        assert.equal(relaxed.entries[0].value.tag, TAG.INT);
    });

    it('锚点可自引用（环状结构），别名指向同一节点对象', () => {
        const cyclic = compose('a: &x [*x]\n');
        const anchored = cyclic.entries[0].value;
        assert.equal(anchored.items[0].kind, 'alias');
        assert.equal(anchored.items[0].target, anchored);

        const shared = compose('a: &x [1]\nb: *x\n');
        assert.equal(shared.entries[0].value, shared.entries[1].value.target);
    });

    it('锚点重定义按最近定义生效', () => {
        const node = compose('a: &x 1\nb: &x 2\nc: *x\n');
        assert.equal(node.entries[2].value.target.value, '2');
    });

    it('别名不能引用后文才出现的锚点', () => {
        assert.throws(
            () => compose('a: *later\nb: &later 1\n'),
            (error) => error instanceof YamlError && error.kind === 'compose',
        );
    });

    it('别名解引用次数受 maxAliasCount 限制，-1 表示关闭', () => {
        const text = 'a: &x 1\nb: [*x, *x, *x]\n';
        assert.throws(
            () => compose(text, { maxAliasCount: 2 }),
            (error) => error instanceof YamlError && error.kind === 'compose' && error.message.includes('maxAliasCount'),
        );
        assert.equal(compose(text, { maxAliasCount: -1 }).entries[1].value.items.length, 3);
    });

    it('mergeKeys 打开时 plain 的 `<<` 标记为 !!merge，关闭时按普通字符串', () => {
        assert.equal(compose('a: &b {x: 1}\nc:\n  <<: *b\n').entries[1].value.entries[0].key.tag, TAG.MERGE);
        assert.equal(
            compose('a: &b {x: 1}\nc:\n  <<: *b\n', { mergeKeys: false }).entries[1].value.entries[0].key.tag,
            TAG.STR,
        );
    });

    it('%YAML 1.1 未显式指定 schema 时切到 yaml11 解析表', () => {
        const legacy = new Parser('%YAML 1.1\n---\nk: 010\n', normalizeParseOptions({})).documents()[0];
        assert.equal(schemaForDocument(legacy, normalizeParseOptions({})), 'yaml11');
        assert.equal(composeDocument(legacy, normalizeParseOptions({})).entries[0].value.tag, TAG.INT);

        // 显式指定 schema 时以调用方为准
        const explicit = normalizeParseOptions({ schema: 'core' });
        assert.equal(schemaForDocument(legacy, explicit), 'core');
    });

    it('集合标签只认已知标签；未知集合标签默认报错', () => {
        assert.equal(compose('!!omap\n- a: 1\n').tag, TAG.OMAP);
        assert.throws(() => compose('!custom [1]\n'), (error) => error instanceof YamlError && error.kind === 'compose');
    });
});
