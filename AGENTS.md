# 项目简介

`ysyuki-lib-on-nodejs` 是跨项目通用的 Node.js 基础库，迁移自某内部项目，
已按域重组（源码根 `src/`，入站 HTTP 服务端模块在 `src/httpServer/`），供多个项目共用。
目标是"在不同项目里的库体验一致"：同一个类、同一套行为约定、同一套命名与注释风格。

## 操作前

你需要严谨按照要求和约束，若你对于任意问题不确定、未知或拿不准，认为要求模糊的，请**先提问后得到准确回答再进行**。

若非项目所有者同意，禁止修改任何 `package.json`（新增、升级、删除依赖），相关操作需单独问询。

若非明确要求，无需对 git 进行包含提交在内的任何操作。

本库是**共用库**：公共 API、行为约定与已发布语义为兼容红线，
不得为了单个宿主项目改动；确需变更必须先向项目所有者确认。

## 环境

- Node.js `>= 24`（LTS）
- 模块体系：ESM（`"type": "module"`）
- 包管理器：`pnpm`
- 代码形式：纯 JavaScript（`.js`），不引入 TypeScript 构建链；`jsconfig.json` + JSDoc 做软类型检查
- 单元测试：内置 `node:test`
- 内部引用：库内一律相对路径（`./config.js`）；对外经 `exports` 子路径导出，
  并提供 `#YukiLib/*` 自引用别名，使宿主项目可沿用既有写法
- 源码布局：源码根 `src/`；入站 HTTP 服务端框架置于 `src/httpServer/`
  （`server` / `context` / `httpReq` / `httpRes` / `appError` / `serverLogger` / `router` / `onion` /
  `middleware`，含子域 barrel），基础设施与出站模块置于 `src/` 根；`test/` 与 `src/` 同构镜像

## 命名风格

函数名、变量名、文件名、目录名用小驼峰 `camelCase`；类名用大驼峰 `PascalCase`；
模块级常量用全大写 `UPPER_SNAKE_CASE`。类文件名与类名解耦（类 `SimpleCode` → 文件 `simpleCode.js`）。

## 注释风格

JSDoc + `jsconfig.json` 的 `checkJs`（等价于全库 `// @ts-check`）语义；

函数注释风格参考：

```js
/**
 * 函数描述
 *
 * @default paramB = 'some text', paramI = 123
 * @param {string} paramA paramA的描述
 * @param {string} [paramB] paramB的描述
 * @param {number} [paramI] paramI的描述
 * @returns {any} 返回值描述
 */
function aFunction(paramA, paramB = 'some text', paramI = 123) {}
```

注意：应在全部 @param 前写一行式 @default 可包含多个赋值

类注释风格参考（`export class` 之前**紧挨着**的那一段就是 IDE hover 能看到的唯一一段）：

```js
/**
 * 类描述（一句话摘要）
 *
 * 契约摘要：本类对外承诺的关键行为，一到三行写完；
 *
 * 常用入口：
 * - aMethod: 说明
 * - bMethod: 说明
 * ...
 */
export class AClass {
    /**
     * 方法描述
     */
    static aStaticMethod() {}
}
```

注意：

1. 类说明必须**紧贴 `export class X {`**，中间只允许空行；一旦隔了 `import`、常量、
   `@typedef` 块或任何函数，那段注释就归了别的节点，类 hover 为空（方法不受影响，
   因为每个方法上方就是它自己那段 JSDoc）。
2. 文件级说明写成 `/** @fileoverview … */`（或普通 `//` 注释）；`@fileoverview` 块**也不能紧贴 class**，紧贴时它会顶掉类注释。
3. `@typedef` / `@property` 一律独立成块，不与类描述同块：同块时整块被 typedef 认领，
   类 hover 为空。只能拆块，不能删（删了会丢类型并抬高 `pnpm check` 诊断数）。

## 验收

```
pnpm check    # tsc 静态类型检查，exit 0
pnpm test     # node:test 全量
```

每个功能模块 = 实现代码与对应测试同仓库同提交；测试必须**自包含**
（用临时目录做宿主根夹具，不依赖库自身目录下的 `config.json` / `.env` / `CA/`）。

## Git 提交

**在非明确指令下，禁止自行操作 Git**，但在用户明确声明后，可进行对应的提交，提交以此格式为准：

```
type: description

- detail1
- detail2
...

```
