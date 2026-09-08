# ysyuki-lib-on-nodejs

跨项目通用的 Node.js 基础库：**零第三方运行时依赖**（纯 Node 内置模块），
自 `xyz.xuezuo.basic` 的 `src/yukiLib/` 抽出，并按域重组为独立源码树（见下方目录结构），供多个项目共用。

目标是"在不同项目里的库体验一致"：同一个类、同一套行为约定、同一套命名与注释风格、同一套验收命令。

## 目录结构

```
src/
  index.js                  包入口（barrel，聚合全部 7 个类）
  config.js                 基础设施：宿主根 / .env / config.json
  logger.js                 基础设施：结构化日志
  funcResult.js             值对象：不可变业务结果
  httpClient.js             出站 HTTP/HTTPS 客户端
  httpServer/               入站 HTTP 服务端域
    index.js                子域入口（barrel：AppError + RequestJson + Router）
    appError.js             业务可预期错误
    requestJson.js          请求体取值 + 统一 JSON 响应出口
    router.js               薄路由
```

`test/` 与 `src/` 同构镜像。

## 模块

| 子路径 | 导出 | 作用 |
| --- | --- | --- |
| `ysyuki-lib-on-nodejs/config` | `Config` | 宿主根解析、`.env` / `config.json` / `dev.config.json` 读取 |
| `ysyuki-lib-on-nodejs/logger` | `Logger` | 结构化日志（stdout + `log/app-YYYY-MM-DD.log` 双通道） |
| `ysyuki-lib-on-nodejs/httpClient` | `HttpClient` | 出站 HTTP/HTTPS 客户端（重定向、超时、自定义 CA） |
| `ysyuki-lib-on-nodejs/funcResult` | `FuncResult` | 不可变业务结果对象 |
| `ysyuki-lib-on-nodejs/httpServer` | `AppError` / `RequestJson` / `Router` | 入站 HTTP 服务端子域入口（barrel） |
| `ysyuki-lib-on-nodejs/httpServer/appError` | `AppError` | 业务可预期错误（宿主入口兜底出口依赖） |
| `ysyuki-lib-on-nodejs/httpServer/requestJson` | `RequestJson` | 请求体取值与统一 JSON 响应出口 |
| `ysyuki-lib-on-nodejs/httpServer/router` | `Router` | 薄路由（占位符、可选段、反向路由） |

`ysyuki-lib-on-nodejs`（包根）导出以上全部 7 个类，等价于逐个从子路径导入；
`ysyuki-lib-on-nodejs/httpServer` 等价于三个 `httpServer/*` 子路径。

## 接入

### 方式一：本地目录依赖（推荐，未发布时）

宿主项目 `package.json`：

```json
{
  "dependencies": {
    "ysyuki-lib-on-nodejs": "link:../YsyukiLibOnNodejs"
  },
  "imports": {
    "#YukiLib/*": "ysyuki-lib-on-nodejs/*"
  }
}
```

`imports` 映射让宿主项目沿用统一的 `#YukiLib/*` 写法（模块路径与库内目录同构）：

```js
import { Config } from '#YukiLib/config';
import { Logger } from '#YukiLib/logger';
import { Router } from '#YukiLib/httpServer/router';
import { AppError, RequestJson } from '#YukiLib/httpServer';
```

也可以直接用包名与子路径：

```js
import { Config, Logger, Router } from 'ysyuki-lib-on-nodejs';
import { RequestJson } from 'ysyuki-lib-on-nodejs/httpServer/requestJson';
```

### 方式二：pnpm workspace

把库与各项目放进同一 workspace 根，依赖写 `"ysyuki-lib-on-nodejs": "workspace:*"`。

### 方式三：发布

`package.json` 的 `private` 改为 `false`（或加 `publishConfig`）后发布；`exports` 已按子路径就绪。

## 宿主根（项目根）解析

`Config.resolveFromRoot(...)`、`Logger` 日志目录、`HttpClient` 的 CA 路径、`.env` / `config.json` /
`dev.config.json` 全部基于**宿主项目根**解析，优先级（首次调用解析后缓存）：

1. `Config.setRootDir(dir)` 显式指定；
2. 环境变量 `YUKI_PROJECT_ROOT`；
3. 入口脚本 `process.argv[1]` 所在目录向上最近的含 `package.json` 的目录；
4. `process.cwd()`。

`Config.setRootDir(null)` 恢复自动解析，并重置配置缓存。测试中建议显式指定临时根目录，
使用例不依赖库自身目录状态。

## 宿主项目需要准备的东西

| 路径 | 必需 | 说明 |
| --- | --- | --- |
| `config.json` | 视项目 | `Config.getConfig(key)` 的取值来源 |
| `.env` | 否 | `Config.getEnv(key)` 补充来源；系统环境变量优先，文件缺失静默忽略 |
| `dev.config.json` | 否 | **存在即开发环境**：日志全级别、`getConfig` 走 dev 覆盖链 |
| `CA/cacert.pem` | 否 | HTTPS 自定义 CA；文件缺失时回退系统 CA |
| `log/` | 否 | 自动创建；`app-YYYY-MM-DD.log`，保留最近 3 天 |

## 与原 `src/yukiLib` 的差异

除下列几点外，行为与原实现一致（原测试用例全部保留并通过）：

1. **宿主根解析**：不再由库自身文件位置反推（`import.meta.url`），改为上表的四级优先级。
2. **`Logger.logDir`**：默认值改为惰性解析（`Config.resolveFromRoot('log')`），
   因此在 `Config.setRootDir()` 之后导入或使用也生效；显式赋值仍可重定向。
3. **`HttpClient` CA**：新增 `HttpClient.caFilePath`（默认宿主根下 `CA/cacert.pem`）；
   证书文件缺失时回退系统 CA，不再抛 `ENOENT`；`closeAgents()` 会重置 HTTPS Agent 与 CA 缓存。
4. **内部引用**：库内一律相对路径（`./config.js`）；对外提供子路径导出与 `#YukiLib/*` 别名。
5. **JSON BOM 容忍**：`config.json` / `dev.config.json` 行首 UTF-8 BOM 会被剥离
   （Windows 记事本、PowerShell 5.1 写出的文件常带 BOM，原实现会静默解析失败、取值全为 `false`）。
6. **目录按域重组**（本次）：源码根由 `src/yukiLib/` 改为 `src/`；`appError` / `requestJson` / `router`
   归入 `src/httpServer/`，子路径相应改为 `ysyuki-lib-on-nodejs/httpServer/*`，并新增子域入口
   `ysyuki-lib-on-nodejs/httpServer`。旧的 `.../appError`、`.../requestJson`、`.../router`
   子路径**不再提供**（宿主需同步改造）；类名、行为与响应契约均未变。

## 验收

```
pnpm check    # tsc 静态类型检查，exit 0
pnpm test     # node:test 全量
```

真实数据库/SMTP 的连通性由项目所有者在部署环境验证（本库不含这两类组件）。
