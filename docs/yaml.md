# YAML 读取 / 写出

自研 **零第三方依赖** 的 YAML 1.2 解析与序列化模块。概览与最短示例见 [README](../README.md)。

```js
import { Yaml, YamlError } from '#YukiLib/yaml';

const value = Yaml.parse('a: 1\nb: [x, y]\n');       // → { a: 1, b: ['x', 'y'] }
Yaml.parseAll('--- 1\n--- 2\n');                     // → [1, 2]（多文档）
Yaml.parseFile('config/app.yaml');                   // 相对路径基于宿主项目根
Yaml.stringify(value);                               // → 'a: 1\nb:\n  - x\n  - y\n'
Yaml.stringifyAll([{ a: 1 }, { b: 2 }]);             // → '---\na: 1\n---\nb: 2\n'
```

## 入口

| 写法 | 说明 |
| --- | --- |
| `ysyuki-lib-on-nodejs/yaml` | 子域入口（barrel），导出 `Yaml` / `YamlError` |
| `#YukiLib/yaml` | 宿主 `imports` 别名，同一实现 |
| `ysyuki-lib-on-nodejs/yaml/yaml` | 入口类所在文件（深子路径） |
| `ysyuki-lib-on-nodejs/yaml/yamlError` | 错误类型 |
| `ysyuki-lib-on-nodejs/yaml/<reader\|scanner\|parser\|composer\|schema\|constructor\|stringify\|options>` | 分层实现：**可达但不属公开契约**，不承诺兼容 |

## API

| 方法 | 返回 | 说明 |
| --- | --- | --- |
| `Yaml.parse(text, options?)` | `any` | 单文档；空输入（空串 / 只有注释）→ `null`；多文档 → 抛 `YamlError`（提示改用 `parseAll`） |
| `Yaml.parseAll(text, options?)` | `any[]` | 全部文档；空输入 → `[]`；空文档 → `null` 元素 |
| `Yaml.parseFile(file, options?)` | `any` | 读文件并解析；绝对路径原样使用，相对路径经 `Config.resolveFromRoot()` 基于宿主根 |
| `Yaml.parseFileAll(file, options?)` | `any[]` | 同上，多文档 |
| `Yaml.stringify(value, options?)` | `string` | 恒以 `\n` 结尾 |
| `Yaml.stringifyAll(values, options?)` | `string` | 每个文档以 `---` 开头（与 `parseAll` 对称） |

`parseFile*` 只读文件、不写任何内容；文件不存在 / 无权限 / 是 UTF-16 编码时抛 `kind: 'file'` 的
`YamlError`（消息只带路径与 errno 码，不带文件内容）。

## 语法覆盖

实现覆盖 YAML 1.2 规范的主体：

- **流 / 行**：UTF-8 BOM（仅流首）、`\n` `\r\n` `\r` NEL LS PS 归一、c-printable 校验（其余控制字符与孤立代理项报错）；
- **块集合**：块映射 / 块序列、缩进式序列（`key:` 下与映射同列）、紧凑嵌套（`- - a`、`- a: 1`）、`?` 显式键与复杂键；
- **流集合**：`[...]` / `{...}`、跨行流式、尾随逗号、流式里的隐式单键映射（`[a: b]` → `[{a: b}]`）、空键（`{: v}`）与空值；
- **标量**：plain（含跨行折叠）、单引号（`''` 转义）、双引号（完整转义集 + 转义换行续行）、
  块标量 `|` / `>`（chomping `-` / `+`、显式缩进指示符 1–9、折叠与更深缩进行规则）；
- **节点属性**：锚点 `&a`、别名 `*a`（只允许引用先前出现的锚点；自引用产生环状结构）、
  标签（`!!str` 简写、`!<verbatim>`、`!local`、`!` 非特定）；
- **指令**：`%YAML`（主版本必须为 1；`%YAML 1.1` 未显式指定 `schema` 时切到 `yaml11` 解析表）、
  `%TAG`（句柄表按文档生效）、未知指令按规范忽略；
- **文档**：`---` / `...`、多文档、指令必须紧跟 `---`、第二个文档起必须显式 `---`；
- **合并键**：`<<`（见下）。

### 本库的显式取舍

| 形态 | 行为 |
| --- | --- |
| 制表符做缩进 | 报错（`kind: 'scan'`）；制表符用作**分隔**（`-\tb`、`a:\tb`）合法 |
| 块集合与 `---` 同行（`--- a: 1`） | 报错：块集合必须另起一行（`--- {a: 1}` 与 `--- a` 合法） |
| 未知 / 本地标签 | 默认报错（`kind: 'compose'`）；`unknownTags: 'ignore'` 时忽略标签按普通节点构造 |
| 简单键 | 必须单行且 ≤1024 字符；块缩进列上的键没等到 `:` 时报错 |
| 别名前向引用 | 报错（别名只能引用先前定义过的锚点） |
| 复杂键 + 普通对象模式 | 报错并提示 `mapAsMap: true` |
| 重复键 | 默认报错；`uniqueKeys: false` 时后值覆盖 |

**不实现**：`!!js/*`、`!!python/*` 之类的宿主语言标签（永不构造任意对象或执行代码）；
`%YAML` 之外的版本协商。

## 错误模型

```js
try {
    Yaml.parseFile('config/app.yaml');
} catch (error) {
    error.name;    // 'YamlError'
    error.kind;    // 'stream' | 'scan' | 'parse' | 'compose' | 'construct' | 'stringify' | 'file'
    error.line;    // 1 起（stringify 阶段为 null）
    error.column;  // 1 起
    error.offset;  // 0 起，按归一化后的文本计（CRLF 视为一个换行）
    error.file;    // parseFile* 时的绝对路径
    error.path;    // stringify 阶段的值路径，如 ['a', 0]
}
```

| kind | 何时出现 |
| --- | --- |
| `stream` | 输入字符集层面：非法控制字符、孤立代理项 |
| `scan` | 扫描阶段：缩进 / 制表符、引号未闭合、非法转义、块标量指示符、指令写法、标签写法、simple key 失效 |
| `parse` | 语法阶段：指令后缺 `---`、第二个文档缺 `---`、节点内容缺失、嵌套超过 `maxDepth` |
| `compose` | 合成阶段：别名未定义 / 前向引用、别名超限、未知标签 |
| `construct` | 构造阶段：重复键、非法 base64 / 时间戳、非标量键、标签与节点种类不匹配、合并展开超限 |
| `stringify` | 序列化阶段：无效 `Date` |
| `file` | 文件读取：不存在、无权限、UTF-16 编码 |

**错误消息纪律（与常见 YAML 库不同）**：消息只含"失败类别 + 位置 + 固定原因"，
**绝不内嵌源文本片段或值本身**——错误对象常被上层 `catch` 后直接写进共享日志，
而 YAML 文件里通常是口令与密钥。需要看上下文时，请由调用方自己在受控终端里打印输入片段。

选项非法（如 `indent: 0`、`schema: 'nope'`）一律抛 `TypeError`，与 `YamlError` 区分。

## 解析选项

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `schema` | `'core'` | 隐式类型表：`'failsafe'` / `'json'` / `'core'` / `'yaml11'` |
| `uniqueKeys` | `true` | 重复键报错；`false` 时后值覆盖 |
| `mergeKeys` | `true` | 支持 `<<` 合并键（YAML 1.1 遗留语法） |
| `mapAsMap` | `false` | `false`：映射 → 普通对象（非标量键报错）；`true`：`Map`（保留任意键类型） |
| `intAsBigInt` | `false` | 整数超出安全整数范围时给 `BigInt`（范围内的仍是 `number`） |
| `maxAliasCount` | `100` | 单文档内"别名解引用次数"与"合并键展开条目数"各自的上限；`-1` 关闭检查 |
| `maxDepth` | `256` | 集合嵌套深度上限（超限抛 `YamlError`，而不是让调用方吃 `RangeError`） |
| `unknownTags` | `'error'` | 未知 / 本地标签：`'error'` 报错，`'ignore'` 忽略标签 |
| `filename` | `undefined` | 仅用于错误定位；`parseFile*` 自动填入绝对路径 |

### 隐式类型表（只作用于 plain 标量）

| 形态 | `core`（默认） | `json` | `failsafe` | `yaml11` |
| --- | --- | --- | --- | --- |
| `~` `null` `Null` `NULL`、空节点 | null | `null`（仅小写） | 字符串 | null |
| `true` `True` `TRUE` / `false` … | 布尔 | `true` / `false` | 字符串 | 布尔（外加 `yes`/`no`/`on`/`off`，不含 `y`/`n`） |
| `123` `-7` | 整数 | 整数 | 字符串 | 整数 |
| `0o17` / `0xF` | 整数 | 字符串 | 字符串 | 整数（`017` 也算八进制，另有 `0b101`、`1_000`、`12:30`） |
| `1.5` `1e3` `.inf` `-.inf` `.nan` | 浮点 | 仅 JSON 数值形态 | 字符串 | 浮点 |
| `2020-01-02`、`2020-01-02T03:04:05Z` | 字符串 | 字符串 | 字符串 | `Date` |
| 其余 | 字符串 | 字符串 | 字符串 | 字符串 |

引号标量与块标量**永不**参与隐式推断（恒为字符串）。
`%YAML 1.1` 声明的文档在未显式传 `schema` 时按 `yaml11` 解析。

### 标签与 JS 类型

| 标签 | JS 类型 |
| --- | --- |
| `!!str` `!!null` `!!bool` `!!int` `!!float` | `string` / `null` / `boolean` / `number`（或 `BigInt`） |
| `!!binary` | `Buffer` |
| `!!timestamp` | `Date`（带时区按绝对时刻；只有日期按 UTC 零点；有时刻无时区按本地时间） |
| `!!set` | `Set` |
| `!!omap` | `Map`（序列形态 `- k: v` 与映射形态都接受） |
| `!!pairs` | `Array<[k, v]>` |
| `!!map` / `!!seq` | 普通对象 / 数组（与默认一致） |
| `!!merge` | 合并键标记（作为普通值时按字符串） |
| 其他 | 默认报错（`unknownTags: 'ignore'` 时忽略标签） |

### 合并键（`<<`）

```yaml
base: &base
  host: 127.0.0.1
  port: 5432
prod:
  <<: *base
  port: 6543      # 显式键覆盖合并来源
```

`<<` 的值可以是映射，也可以是**映射序列**（靠前者优先）；合并来源内部的 `<<` 会先展开；
显式键永远优先，且合并来源之间的同名键不算"重复键"。`mergeKeys: false` 时 `<<` 只是一个普通键。

## 序列化选项

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `indent` | `2` | 缩进宽度（1–9） |
| `lineWidth` | `80` | 行宽（0 表示不折行）：流式集合换行、双引号标量 `\` 续行、plain / 单引号在空格处折行 |
| `flowLevel` | `-1` | 深度 ≤ 该值的集合写成流式（`-1` 全块式，`Infinity` 全流式） |
| `schema` | `'core'` | 决定"这串字符串要不要加引号"的隐式类型表 |
| `sortKeys` | `false` | `false` / `true` / 比较函数 |
| `aliasDuplicateObjects` | `true` | 重复引用的对象用锚点 / 别名；关闭后各自展开（环状结构仍强制用锚点） |

### 值 → YAML

| 值 | 写出形态 |
| --- | --- |
| `null` / `undefined` / 函数 / `symbol` | `null` |
| `-0` | `-0.0`（整数形态会丢掉符号） |
| `NaN` / `±Infinity` | `.nan` / `.inf` / `-.inf` |
| `BigInt` | 整数字面量（读回类型由 `intAsBigInt` 决定） |
| 字符串 | 必要才加引号：plain → 单引号 → 双引号；含换行且适合时用块字面量（`\|-` / `\|` / `\|+`） |
| 含制表符 / BOM / 控制字符的字符串 | 双引号 + 转义（`\t` / `\uFEFF` / `\x01` …） |
| `Date` | `!!timestamp <ISO 8601>` |
| `Buffer` / `Uint8Array` | `!!binary <base64>` |
| `Map` | `!!omap`（保留精确键与顺序） |
| `Set` | `!!set` |
| 数组 / 普通对象 | 块式序列 / 映射（空集合恒为 `[]` / `{}`） |
| 重复引用 / 环状结构 | `&ref1` + `*ref1` |

## 安全约束

- **永不执行代码、永不构造任意类型**：显式标签只映射到上表已知的内建类型；未知 / 本地标签默认报错。
- **规模限额**：`maxAliasCount`（别名解引用与合并键展开）与 `maxDepth`（嵌套深度）
  让恶意输入得到 `YamlError`，而不是 OOM 或 `RangeError`。
- **原型污染防护**：映射的所有属性写入一律走 `Object.defineProperty`，
  文档里的 `__proto__` / `constructor` 只会成为普通自有属性，不会改写原型。
- **错误消息脱敏**：不含源文本片段与值本身。
- **文件读取只读**：`parseFile*` 不写文件、不创建目录。

## round-trip 例外清单

`parse(stringify(v))` 与 `v` 等值是本模块的验收标准之一（`test/yaml/roundTrip.test.js` 逐条覆盖），
下列情况**不等值**，属于设计取舍：

| 输入 | 读回 |
| --- | --- |
| `undefined`、函数、`symbol` | `null`（对象键不会丢，值为 `null`） |
| `BigInt`（如 `10n`） | 小整数 → `number`；超安全范围 → 需 `intAsBigInt: true` 才是 `BigInt` |
| `-0` | `-0`（写成 `-0.0`，保留符号） |
| `Map` / `Set` / `Date` / `Buffer` | 需显式标签，读回类型一致（见上表） |
| 键的字符串化 | 普通对象模式下 `1` / `true` / `null` / `Date` 作为键会变成字符串（`mapAsMap: true` 可保留精确键） |
| 行内注释、原始引号样式、缩进宽度 | 不保留（语义等值，样式重排） |

## 测试与验收

```bash
pnpm check    # tsc 静态类型检查（jsconfig.json + JSDoc）
pnpm test     # node:test 全量
```

YAML 相关用例分布：`test/yaml/*.test.js` 按层（reader / scanner / parser / composer / schema /
constructor / stringify）分别断言，另有公开入口契约（`index.test.js`）、round-trip
（`roundTrip.test.js`）与规范示例回归（`specExamples.test.js` + `specCases.js`）。
