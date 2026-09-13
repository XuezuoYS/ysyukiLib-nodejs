/**
 * @fileoverview YAML 子域入口（barrel）
 *
 * 自研零依赖的 YAML 1.2 读取 / 写出：
 * - `Yaml`：解析（`parse` / `parseAll` / `parseFile` / `parseFileAll`）与
 *   序列化（`stringify` / `stringifyAll`）；
 * - `YamlError`：统一错误类型（`kind` + 行列定位，消息不含原文片段）。
 *
 * 分层实现（内部文件不承诺兼容，但按需要可直接引用）：
 * `reader`（字符流）→ `scanner`（token）→ `parser`（event）→ `composer`（节点图）→
 * `constructor`（JS 值）；`schema`（标签与类型推断）与 `stringify`（写出）、`options`（选项）。
 *
 * 以下写法等价（同一实现，类对象同一）：
 * - `import { Yaml } from 'ysyuki-lib-on-nodejs/yaml'`
 * - `import { Yaml } from '#YukiLib/yaml'`
 * - `import { Yaml } from 'ysyuki-lib-on-nodejs/yaml/yaml'`
 */
export { Yaml } from './yaml.js';
export { YamlError } from './yamlError.js';
