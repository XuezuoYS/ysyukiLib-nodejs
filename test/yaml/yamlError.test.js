import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { YamlError } from '#YukiLib/yaml/yamlError';

/**
 * `YamlError` 契约
 *
 * 重点是一条"脱敏纪律"：message 只带位置与固定原因，**不带源文本片段与值**——
 * 错误对象常被上层 catch 后直接写进共享日志，而 YAML 文件里通常是口令与密钥。
 */
describe('YamlError', () => {
    it('解析类错误：name / kind / 位置字段齐全', () => {
        const error = new YamlError('scan', '测试原因', { line: 3, column: 7, offset: 42, file: '/tmp/a.yaml' });

        assert.ok(error instanceof Error);
        assert.ok(error instanceof YamlError);
        assert.equal(error.name, 'YamlError');
        assert.equal(error.kind, 'scan');
        assert.equal(error.reason, '测试原因');
        assert.equal(error.line, 3);
        assert.equal(error.column, 7);
        assert.equal(error.offset, 42);
        assert.equal(error.file, '/tmp/a.yaml');
        assert.equal(error.path, null);
        assert.equal(error.message, '/tmp/a.yaml：YAML 解析失败（第 3 行第 7 列）：测试原因');
    });

    it('位置缺失时降级为"位置未知"，不抛错', () => {
        const error = new YamlError('parse', '缺少内容');
        assert.equal(error.line, null);
        assert.equal(error.column, null);
        assert.equal(error.offset, null);
        assert.equal(error.file, null);
        assert.equal(error.message, 'YAML 解析失败（位置未知）：缺少内容');
    });

    it('序列化错误带路径文本', () => {
        const error = new YamlError('stringify', 'Date 无效', { path: ['a', 0, 'b'] });
        assert.equal(error.kind, 'stringify');
        assert.deepEqual(error.path, ['a', 0, 'b']);
        assert.equal(error.message, 'YAML 序列化失败（路径 $.a[0].b）：Date 无效');

        const quoted = new YamlError('stringify', '原因', { path: ['a b'] });
        assert.equal(quoted.message, 'YAML 序列化失败（路径 $["a b"]）：原因');
    });

    it('文件类错误带绝对路径', () => {
        const error = new YamlError('file', '无法读取文件（ENOENT）', { file: '/tmp/missing.yaml' });
        assert.equal(error.message, 'YAML 文件读取失败（/tmp/missing.yaml）：无法读取文件（ENOENT）');
    });

    it('message 不包含源文本片段：只报固定原因', () => {
        const secret = 'DB_PASSWORD=hunter2';
        const error = new YamlError('scan', '此处不允许出现映射值 ":"', { line: 1, column: 5 });
        assert.equal(error.message.includes(secret), false);
        assert.equal(error.message.includes('hunter2'), false);
        assert.ok(error.message.includes('第 1 行第 5 列'));
    });
});
