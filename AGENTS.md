# 项目简介

`ysyuki-lib-on-nodejs` 是跨项目通用的 Node.js 基础库，迁移自某内部项目，
已按域重组（源码根 `src/`，入站 HTTP 服务端模块在 `src/httpServer/`），供多个项目共用。
目标是"在不同项目里的库体验一致"：同一个类、同一套行为约定、同一套命名与注释风格。

## 操作前

你需要严谨按照要求和约束，若你对于任意问题不确定、未知或拿不准，认为要求模糊的，请先提问后得到准确回答再进行。

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
参考 `src/config.js` 顶部模块注释与各方法注释的写法。

## 验收

```
pnpm check    # tsc 静态类型检查，exit 0
pnpm test     # node:test 全量
```

每个功能模块 = 实现代码与对应测试同仓库同提交；测试必须**自包含**
（用临时目录做宿主根夹具，不依赖库自身目录下的 `config.json` / `.env` / `CA/`）。
