import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as yamlBarrel from 'ysyuki-lib-on-nodejs/yaml';
import * as topBarrel from 'ysyuki-lib-on-nodejs';
import { Yaml } from '#YukiLib/yaml/yaml';
import { YamlError } from '#YukiLib/yaml/yamlError';
import { Yaml as AliasYaml, YamlError as AliasYamlError } from '#YukiLib/yaml';

/**
 * YAML 子域入口（yaml barrel）导出契约
 *
 * 验证四种写法指向同一实现（同一类对象）：
 * - 子域 barrel：`ysyuki-lib-on-nodejs/yaml` 与别名 `#YukiLib/yaml`；
 * - 深子路径：`#YukiLib/yaml/yaml`、`#YukiLib/yaml/yamlError`（由 `./yaml/*` 通配派生）；
 * - 顶层 barrel：`ysyuki-lib-on-nodejs`。
 */
describe('yaml 子域入口与子路径导出', () => {
    it('barrel 导出 Yaml 与 YamlError', () => {
        assert.deepEqual(Object.keys(yamlBarrel).sort(), ['Yaml', 'YamlError']);
    });

    it('子域 barrel 与深子路径为同一实现（同一类对象）', () => {
        assert.equal(yamlBarrel.Yaml, Yaml);
        assert.equal(yamlBarrel.YamlError, YamlError);
    });

    it('#YukiLib/yaml 别名与子域 barrel 指向同一实现', () => {
        assert.equal(AliasYaml, Yaml);
        assert.equal(AliasYamlError, YamlError);
    });

    it('子域 barrel 与顶层 barrel 为同一实现', () => {
        assert.equal(yamlBarrel.Yaml, topBarrel.Yaml);
        assert.equal(yamlBarrel.YamlError, topBarrel.YamlError);
    });

    it('成员开箱可用：解析、序列化、抛错', () => {
        assert.deepEqual(yamlBarrel.Yaml.parse('a: 1\n'), { a: 1 });
        assert.equal(yamlBarrel.Yaml.stringify({ a: 1 }), 'a: 1\n');
        assert.deepEqual(yamlBarrel.Yaml.parseAll('--- a\n--- b\n'), ['a', 'b']);
        assert.throws(
            () => yamlBarrel.Yaml.parse('a: 1\na: 2\n'),
            (error) => error instanceof yamlBarrel.YamlError && error.kind === 'construct',
        );
    });
});
