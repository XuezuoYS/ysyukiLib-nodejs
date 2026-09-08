# ysyuki-lib-on-nodejs

跨项目通用的 Node.js 基础库：**零第三方运行时依赖**（纯 Node 内置模块），
迁移自某内部项目，并按域重组为独立源码树（见下方目录结构），供多个项目共用。

目标是"在不同项目里的库体验一致"：同一个类、同一套行为约定、同一套命名与注释风格、同一套验收命令。

## 目录结构

```
src/
  index.js                  包入口（barrel，聚合全部 11 个类）
  config.js                 基础设施：宿主根 / .env / config.json
  logger.js                 基础设施：结构化日志
  funcResult.js             值对象：不可变业务结果
  httpClient.js             出站 HTTP/HTTPS 客户端
  httpServer/               入站 HTTP 服务端框架
    index.js                子域入口（barrel）
    server.js               HttpServer：入口、兜底出口、优雅关闭
    context.js              请求上下文（AsyncLocalStorage）
    httpReq.js              HttpReq：请求侧一行式取值
    httpRes.js              HttpRes：响应侧一行式输出
    appError.js             业务可预期错误
    serverLogger.js         ServerLogger：服务器日志包装（包装 src/logger.js）
    router.js               模板路由（{id} / {id:int}、分组、405、HEAD）
    onion.js                中间件洋葱组合
    middleware.js           Middleware：cors / accessLog / requestId（opt-in）
```

`test/` 与 `src/` 同构镜像。

## 模块

| 子路径 | 导出 | 作用 |
| --- | --- | --- |
| `ysyuki-lib-on-nodejs/config` | `Config` | 宿主根解析、`.env` / `config.json` / `dev.config.json` 读取 |
| `ysyuki-lib-on-nodejs/logger` | `Logger` / `SubLogger` | 结构化日志（stdout + `log/app-YYYY-MM-DD.log` 双通道）；`Logger.create({ level })` 创建等级独立的子 logger |
| `ysyuki-lib-on-nodejs/httpClient` | `HttpClient` | 出站 HTTP/HTTPS 客户端（重定向、超时、自定义 CA、响应体上限 `maxBodyMb`） |
| `ysyuki-lib-on-nodejs/funcResult` | `FuncResult` | 不可变业务结果对象 |
| `ysyuki-lib-on-nodejs/httpServer` | `AppError` / `HttpReq` / `HttpServer` / `HttpRes` / `Middleware` / `Router` / `ServerLogger` | 入站 HTTP 服务端子域入口（barrel） |
| `ysyuki-lib-on-nodejs/httpServer/server` | `HttpServer` | 服务入口：create / listen / 兜底出口 / 超时 / 优雅关闭（进程级共享信号注册，`exitOnShutdown` 默认 false，`logLevel` 可选） |
| `ysyuki-lib-on-nodejs/httpServer/context` | `runWithContext` / `getCurrentContext` / `tryGetCurrentContext` | 请求上下文（AsyncLocalStorage） |
| `ysyuki-lib-on-nodejs/httpServer/httpReq` | `HttpReq` | 请求侧一行式取值（body / query / param / header / cookie / ip） |
| `ysyuki-lib-on-nodejs/httpServer/httpRes` | `HttpRes` | 响应侧一行式输出（jsonRes / fastResEmpty / fastResRedirect / fastResError / header / cookie） |
| `ysyuki-lib-on-nodejs/httpServer/appError` | `AppError` | 业务可预期错误（入口兜底出口依赖） |
| `ysyuki-lib-on-nodejs/httpServer/serverLogger` | `ServerLogger` | 服务器日志（实例化：服务名与等级随实例，`new ServerLogger({ serviceName, level })`） |
| `ysyuki-lib-on-nodejs/httpServer/router` | `Router` | 模板路由（`{id}` / `{id:int}`、分组、405、HEAD、反向路由） |
| `ysyuki-lib-on-nodejs/httpServer/middleware` | `Middleware` | 内置可选中间件（cors / accessLog / requestId）；`cors` 默认 `origin: '*'`，`credentials: true` 须显式指定非 `'*'` 的 origin |
| `ysyuki-lib-on-nodejs/httpServer/onion` | `compose` | 中间件洋葱组合（框架内部工具） |

`ysyuki-lib-on-nodejs`（包根）导出以上全部 11 个类，等价于逐个从子路径导入；
`ysyuki-lib-on-nodejs/httpServer` 等价于七个 `httpServer/*` 子路径。

## 快速上手（httpServer 框架）

```js
import { HttpServer, Router, HttpReq, HttpRes, AppError, Logger } from '#YukiLib/httpServer';

const router = new Router({ basePath: '/api' });

// 路径参数按类型转换后作为首参注入；返回值自动序列化为 JSON 200
router.get('/v1/users/{uid:int}', ({ uid }) => ({ uid, type: typeof uid }));

// 一行式取值：缺失/类型不符 → 400 {status:'参数错误'}，显式默认值则不报错
router.post('/v1/login', async () => {
    const username = HttpReq.getPostData('username', 'string');
    const remember = HttpReq.getPostData('remember', 'bool', false);
    const ua = HttpReq.getHeader('user-agent');
    if (username === 'bad') {
        throw new AppError('密钥错误', 401);      // 或 HttpRes.fastResError('密钥错误', 401)
    }
    return { username, remember, ua };            // 等价于 HttpRes.jsonRes({...})
});

// 中间件洋葱：全局（router.use）/ 分组（group 内 use）/ 路由级（options.middleware）
router.use(async (ctx, next) => {
    const startedAt = Date.now();
    await next();
    Logger.info('access', { path: ctx.path, ms: Date.now() - startedAt });
});

HttpServer.create({ router, serviceName: 'example-service' })
    .listen(8000, '127.0.0.1', () => Logger.info('服务已启动'));
```

响应与错误契约：JSON 输出 4 空格缩进、斜杠与非 ASCII 不转义；错误统一
`{ "status": message }`；404 / 405 维持 `{ name, error, path, method }` 形状（405 附带 `Allow` 头）。

## 接入

### 方式一：本地目录依赖（推荐，未发布时）

宿主项目 `package.json`：

```json
{
  "dependencies": {
    "ysyuki-lib-on-nodejs": "link:../ysyukiLib-nodejs"
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
import { HttpServer, Router, HttpReq, HttpRes, AppError } from '#YukiLib/httpServer';
```

也可以直接用包名与子路径：

```js
import { Config, Logger, Router } from 'ysyuki-lib-on-nodejs';
import { HttpRes } from 'ysyuki-lib-on-nodejs/httpServer/httpRes';
```

### 方式二：pnpm workspace

把库与各项目放进同一 workspace 根，依赖写 `"ysyuki-lib-on-nodejs": "workspace:*"`。

### 方式三：发布

本包已可直接发布：`private: false`、`exports` 已按子路径就绪、`files` 只收 `src`；
发布前确认 `version` 与 `repository` 指向的仓库一致即可。

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

## 日志等级与配置隔离

- **入口级（`Logger` 静态成员）**：`Logger.now`（记录日期源，子 logger 不提供日期配置）、
  `Logger.logDir`、`Logger.defaultLevel`（实时求值：宿主根存在 `dev.config.json` 即 `info`，否则 `warn`）；
- **子 logger 级**：`Logger.create({ level })` 返回的 `SubLogger` 各自持有记录等级，
  互不影响，也不影响根 `Logger`；`ServerLogger` 同样按实例隔离（服务名 + 等级）。
- 等级为**阈值**语义：`warn` 记 warn+error，`info` 记全部，`error` 只记 error；
  未显式设置时实时跟随 `Logger.defaultLevel`。

```js
import { Logger } from '#YukiLib/logger';
import { HttpServer, Router } from '#YukiLib/httpServer';

const access = Logger.create({ level: 'info' });  // 只影响这个子 logger
access.info('访问明细');                            // 生产环境同样记录
Logger.info('一般信息');                            // 生产环境默认 warn 阈值 → 丢弃

const server = HttpServer.create({ router, serviceName: 'api', logLevel: 'info' });
server.logger.level = 'warn';                       // 运行期调整本实例等级（不影响其它实例）
```

## 与抽出前实现的差异

除下列几点外，行为与原实现一致（原测试用例全部保留并通过）：

1. **宿主根解析**：不再由库自身文件位置反推（`import.meta.url`），改为上表的四级优先级。
2. **`Logger.logDir`**：默认值改为惰性解析（`Config.resolveFromRoot('log')`），
   因此在 `Config.setRootDir()` 之后导入或使用也生效；显式赋值仍可重定向。
3. **`HttpClient` CA**：新增 `HttpClient.caFilePath`（默认宿主根下 `CA/cacert.pem`）；
   证书文件缺失时回退系统 CA，不再抛 `ENOENT`；`closeAgents()` 会重置 HTTPS Agent 与 CA 缓存。
4. **内部引用**：库内一律相对路径（`./config.js`）；对外提供子路径导出与 `#YukiLib/*` 别名。
5. **JSON BOM 容忍**：`config.json` / `dev.config.json` 行首 UTF-8 BOM 会被剥离
   （Windows 记事本、PowerShell 5.1 写出的文件常带 BOM，原实现会静默解析失败、取值全为 `false`）。
6. **目录按域重组**（本次）：源码根由抽出前的位置改为 `src/`；`appError` / `requestJson` / `router`
   归入 `src/httpServer/`，子路径相应改为 `ysyuki-lib-on-nodejs/httpServer/*`，并新增子域入口
   `ysyuki-lib-on-nodejs/httpServer`。旧的 `.../appError`、`.../requestJson`、`.../router`
   子路径**不再提供**（宿主需同步改造）；类名、行为与响应契约均未变。
7. **httpServer 框架化**（本次，破坏性）：
   - `RequestJson` 拆为 `HttpReq`（请求侧一行式取值）+ `HttpRes`（响应侧一行式输出），
     基于 `AsyncLocalStorage` 的请求上下文，类名与子路径均变更；
   - 路由改为 FastAPI 风格 `{id}` / `{id:int}` 模板（取代 `[i:id]`），新增分组 `group()`、
     中间件洋葱、405（带 `Allow`）、HEAD→GET、路径参数按类型转换；
   - 新增 `HttpServer` 入口（create / listen / 五分支兜底 / 1 MB 请求体上限 /
     非法 JSON 400 / 超时 / 优雅关闭）与 `Middleware`（cors / accessLog / requestId，opt-in）；
   - `Logger` 仍在 `src/logger.js`（基础设施），`ServerLogger` 只是它的服务器场景包装；
   - 保持不变的契约：JSON 序列化格式、`{status: message}` 错误体、校验失败 400、
     404/405 响应体形状、类型系统（`array` 仍兼收对象）。

8. **路由正则护栏**（本次）：`@` 自定义正则缺锚定时自动补 `^...$`（此前遗漏会变成子串匹配）；
   正则源超过 1024 字符注册即抛错；疑似灾难性回溯（嵌套量词，如 `(a+)+`）仅记 warn、不阻断注册。
   `@` 正则与 `addMatchTypes` 片段必须是静态、由开发者编写的字符串，禁止拼接请求数据。

## 从旧 API 迁移（宿主改造用）

| 旧写法 | 新写法 |
| --- | --- |
| `new RequestJson(rawBody)` + `getPostDataItem('k','int')` | `HttpReq.getPostData('k','int')`（无需构造） |
| `RequestJson.responseJson(res, data, code)` | `HttpRes.jsonRes(data, code)` 或处理器 `return data` |
| `RequestJson.responseFastError('x', 401)` | `HttpRes.fastResError('x', 401)` 或 `throw new AppError('x', 401)` |
| `RequestJson.responseFastJump(res, url, 307)` | `HttpRes.fastResRedirect(url, 307)` |
| `ctx.getQueryParam(key)` | `HttpReq.getQuery(key)` |
| `router.map('GET', '/x/[i:id]', handler, name)` | `router.get('/x/{id:int}', handler, { name })` |
| 处理器签名 `(ctx) => ...` | `(params, ctx) => ...`（路径参数已按类型转换） |
| 宿主 `server.js`（handleRequest / createAppServer） | `HttpServer.create({ router, serviceName }).listen(...)` |
| `#YukiLib/appError` | `#YukiLib/httpServer/appError`（类名不变） |

## 验收

```
pnpm check    # tsc 静态类型检查，exit 0
pnpm test     # node:test 全量
```

真实数据库/SMTP 的连通性由项目所有者在部署环境验证（本库不含这两类组件）。

## 许可证

[MIT](./LICENSE)
