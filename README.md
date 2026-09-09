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
| `ysyuki-lib-on-nodejs/httpClient` | `HttpClient` | 出站 HTTP/HTTPS 客户端（重定向、超时、自定义 CA、响应体上限 `maxBodyMb`、同实例并发请求头隔离） |
| `ysyuki-lib-on-nodejs/funcResult` | `FuncResult` | 不可变业务结果对象 |
| `ysyuki-lib-on-nodejs/httpServer` | `AppError` / `HttpReq` / `HttpServer` / `HttpRes` / `Middleware` / `Router` / `ServerLogger` / `encodeUrlParam` | 入站 HTTP 服务端子域入口（barrel） |
| `ysyuki-lib-on-nodejs/httpServer/server` | `HttpServer` | 服务入口：create / listen / 兜底出口 / 超时 / 优雅关闭（进程级共享信号注册，`exitOnShutdown` 默认 false，`logLevel` 可选） |
| `ysyuki-lib-on-nodejs/httpServer/context` | `runWithContext` / `getCurrentContext` / `tryGetCurrentContext` | 请求上下文（AsyncLocalStorage） |
| `ysyuki-lib-on-nodejs/httpServer/httpReq` | `HttpReq` | 请求侧一行式取值（body / query / param / header / cookie / ip） |
| `ysyuki-lib-on-nodejs/httpServer/httpRes` | `HttpRes` | 响应侧一行式输出（jsonRes / fastResEmpty / fastResRedirect / fastResError / header / cookie） |
| `ysyuki-lib-on-nodejs/httpServer/appError` | `AppError` | 业务可预期错误（入口兜底出口依赖） |
| `ysyuki-lib-on-nodejs/httpServer/serverLogger` | `ServerLogger` | 服务器日志（实例化：服务名与等级随实例，`new ServerLogger({ serviceName, level })`）；`response` 按状态码分级记响应状态日志 |
| `ysyuki-lib-on-nodejs/httpServer/router` | `Router` / `encodeUrlParam` | 模板路由（`{id}` / `{id:int}`、分组、405、HEAD、反向路由、注册期正则护栏、块外字面量转义）；`encodeUrlParam` 为 URL 参数编码 |
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

执行顺序：**全局中间件（`router.use`）先于路由决策**，因此 404 / 405 也会经过全局中间件
（CORS 预检、全局鉴权、访问日志都覆盖未命中与方法不符的请求；`Middleware.cors()` 的
OPTIONS 预检因此能正常短路返回 204，而不是被 405 提前拒掉）。分组中间件与
`options.middleware` 仍只作用于命中路由。

请求体两种来源，**取值写法完全一致**：

| `Content-Type` | 解析器 | `HttpReq.getPostData` 校验语义 |
| --- | --- | --- |
| `application/json`（或未声明） | `parseJsonBody` | 严格：`int` 要求 JSON 数字、`bool` 要求布尔值 |
| `application/x-www-form-urlencoded` | `parseFormBody` | 字符串来源：`'42'` 可取 `int`、`'true'` 可取 `bool`（与 `getQuery` 一致） |

```js
router.post('/login', () => {
    // 无论客户端发 JSON 还是表单，这一行都成立
    const username = HttpReq.getPostData('username', 'string');
    const remember = HttpReq.getPostData('remember', 'bool', false);
    return { username, remember };
});
```

表单同名键取**首个**值（与 `getQuery` 一致）；`getBody()` 在表单来源下返回字符串值对象，
需要类型转换请用 `getPostData` 声明类型。空体/纯空白一律按空对象处理，非 JSON 且非表单的
`Content-Type` 仍按 JSON 解析（非法即 400）。

### 取值类型保证

声明了 `type` 的取值**一律返回该类型**（`string` → string、`int` / `float` → number、
`bool` → boolean、`array` → array）。字符串来源（表单体 / query / param / header / cookie）
按字符串来源语义强转；值缺失时返回显式缺省值，未显式传缺省值则返回该类型的零值：

| `type` | 返回类型 | 缺失时的零值 |
| --- | --- | --- |
| `string` / `none` / 其它 | string / 原值 | `''` |
| `int` / `float` | number | `0` |
| `bool` | boolean | `false` |
| `array` | array | `[]` |

```js
const uid = HttpReq.getCookie('uid', 'int');        // number；cookie 缺失 → 0
const vip = HttpReq.getHeader('x-vip', 'bool');     // boolean；头缺失 → false
const page = HttpReq.getQuery('page', 'int', 1);    // number；缺省值优先于零值
```

`getHeader` / `getCookie` 的第二参是 `type`（默认 `none`），不是已知类型名时按"缺省值"
处理（兼容旧写法 `getCookie('sid', 'def')`）；注意 `'none'` 等已知类型名会被当作类型声明，
缺省值请用第三参。

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
| `config.json` | 视项目 | `Config.getConfig(key)` 的取值来源；**缺失、解析失败或内容整体不是对象（如文件就是 `null`）时 `getConfig` 一律返回 `false`，并记一次 WARN 日志**（同一宿主根只告警一次，`setRootDir` 重置；WARN 只带文件路径与**脱敏后的**失败类别，不带异常 message 与文件内容） |
| `.env` | 否 | `Config.getEnv(key)` 补充来源；系统环境变量优先，文件缺失静默忽略 |
| `dev.config.json` | 否 | **存在即开发环境**：日志全级别、`getConfig` 走 dev 覆盖链 |
| `CA/cacert.pem` | 否 | HTTPS 自定义 CA；**公共站点无需配置**（Node 自带根 CA 且默认校验证书链），文件缺失时回退系统 CA；`ca` 为替换语义，只放需额外信任的私有 CA |
| `log/` | 否 | 自动创建；`app-YYYY-MM-DD.log`，保留最近 3 天 |

## 日志等级与配置隔离

- **入口级（`Logger` 静态成员）**：`Logger.now`（记录日期源，子 logger 不提供日期配置）、
  `Logger.logDir`、`Logger.defaultLevel`（宿主根存在 `dev.config.json` 即 `info`，否则 `warn`）；
  该判定**按开发配置路径缓存**（写日志是热路径，避免每条日志同步 stat）：
  `Config.setRootDir()` 与改 `Config.devConfigFile` 会自动失效，
  同一路径上增删 `dev.config.json` 需显式 `Logger.resetDevCache()`（或重启）；
- **子 logger 级**：`Logger.create({ level })` 返回的 `SubLogger` 各自持有记录等级，
  互不影响，也不影响根 `Logger`；`ServerLogger` 同样按实例隔离（服务名 + 等级）。
- 等级为**阈值**语义：`warn` 记 warn+error，`info` 记全部，`error` 只记 error；
  未显式设置时跟随 `Logger.defaultLevel`。
- **记录日志不抛错**：`fields` 里的循环引用 / `BigInt` / 抛错的 getter 与 `toJSON` 会降级成
  `[Circular]` / `[BigInt 10]` / `[Getter threw]` 等标记（仍是合法 JSON），stdout 与文件两通道
  各自独立失败——Logger 常是 `catch` / `onError` 的兜底路径，不能反过来炸宿主。
- 文件滚动状态是**「日期 + 目录」两者**：跨日、当日重设 `Logger.logDir`、`Config.setRootDir()`
  换宿主根，都会在下一写建好目标目录并清理；目录运行期被外部删除也会在下一次写入补建重试。

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
   证书文件缺失时回退系统 CA，不再抛 `ENOENT`；改 `caFilePath` 会在下次 HTTPS 请求时
   自动重新加载并重建 Agent（无需手动 `closeAgents()`）；同一路径下替换证书内容仍需
   `closeAgents()`。注意 `https.Agent` 的 `ca` 是**替换**内置根证书列表而非追加，
   该文件只应放需要额外信任的私有 CA（公共站点无需配置）。
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

9. **反向路由编码**（本次，破坏性）：`Router.generate()` 默认对参数值做 URL 编码
   （`{path:path}` / `{rest:all}` 按段编码、保留斜杠），可用 `generate(name, params, { encode: false })` 关闭；
   新增 `encodeUrlParam(value, { keepSlash })` 供手工拼 URL 复用；`@` 自定义正则路由不再支持反向生成
   （此前会静默返回正则源字符串）。

10. **表单请求体**（本次）：新增 `application/x-www-form-urlencoded` 解析（`parseFormBody`），
    `HttpReq.getPostData` 按请求体来源选择校验语义（JSON 严格 / 表单字符串强转），调用写法不变；
    此前表单请求会被当非法 JSON 直接 400。同名键取首值，与 `getQuery` 一致。

11. **取值类型保证**（本次）：`getHeader` / `getCookie` 新增 `type` 位（默认 `none`），
    与 `getQuery` / `getParam` 一致地按声明类型返回（`getCookie('uid','int')` → number）；
    值缺失且未传缺省值时返回该类型零值（`bool` → false、`int` / `float` → 0、`array` → []、
    `string` → ''）。第二参非已知类型名时仍按缺省值处理（兼容旧写法），但 `'none'` 等
    已知类型名不再能作为缺省值字面量。

12. **超限请求体与路径折叠**（本次）：请求体超限（413）后剩余数据会被读掉，keep-alive
    连接可继续复用（此前复用会 ECONNRESET）；`normalizePath` 折叠两个及以上连续斜杠
    （此前只折叠一次，`//a///b/` 会残留 `//`）。

13. **兜底出口**（本次）：响应已开始后发生异常时 destroy 响应，客户端立即收到连接中断
    （此前只记日志，客户端会一直等到 `requestTimeout`）。

14. **config.json 不可用告警**（本次）：`config.json` 缺失或解析失败时，`Config.getConfig`
    仍返回 `false`（行为不变），但会经 `Logger.warn` 记录一次警告（含文件路径与失败原因，
    不输出文件内容）；同一宿主根只告警一次，`setRootDir()` 重置。此前完全静默，
    配置未生效却无从察觉。（"不输出文件内容"这一承诺最初被 `reason` 破坏，见第 22 条。）

15. **默认等级缓存**（本次）：`Logger.defaultLevel` 的 dev 判定按开发配置路径缓存，
    写日志不再每条同步 `existsSync`（实测 8.56µs/条 → 0.37µs/条，降幅 96%）。
    `Config.setRootDir()` / `Config.devConfigFile` 赋值自动失效；同一路径上增删
    `dev.config.json` 需显式 `Logger.resetDevCache()`（此前为实时检查，代价是每条日志一次 stat）。

16. **全局中间件先于路由决策**（本次，行为变更）：此前路由匹配（含 404/405）先执行，
    全局中间件只在命中路由时运行——导致 `Middleware.cors()` 的 OPTIONS 预检被 405 拒掉，
    真实浏览器跨域请求直接失败。现改为全局中间件包裹路由决策，404/405 也经过它
    （跨域头、鉴权、访问日志均覆盖）；分组/路由级中间件仍只作用于命中路由。
    顺带：HEAD 响应补 `Content-Length`（`data` 省略 / 为 `undefined` 的空体形态补 `0`，
    与 GET 一致；此处若直接取 `undefined` 的字节数会抛 `ERR_INVALID_ARG_TYPE` 转 500）；
    中间件漏调 `next()` 记 WARN。

17. **路由块外字面量转义**（本次，修复）：模板路由里**占位块之外**的部分此前被原样拼进匹配正则，
    于是按正则语义生效——`.` 成了通配符（实测 `/a.b/{id:int}` 命中 `/axb/7`），`+` `(` `|` 等同理。
    现按纯文本处理：编译时对字面量段转义 `[.*+?^${}()|[\]\\]`，`group()` 前缀与块后缀
    （如 `/report.{id:int}.pdf`）一并生效。影响面：仅含占位符的模板路由（无占位符一直是字符串精确比较）；
    `@` 自定义正则与 `addMatchTypes` 片段仍按正则解析、不转义；`generate()` 输出的仍是 URL 字面量。

18. **顶层非对象容错**（本次，修复）：`config.json` / `dev.config.json` 内容整体是 `null`
    （或数字 / 字符串 / 布尔）时 `JSON.parse` **成功**并返回非对象值，此前 `Config.getConfig`
    会抛 `TypeError: Cannot convert undefined or null to object`，且缓存会被写成 `null`、
    `isConfigLoaded` 还会被误置为"已加载"。现与"解析失败"同等对待：不写缓存、不置已加载、
    `getConfig` 一律返回 `false`；`config.json` 照旧记一次 WARN（原因写明"内容不是对象"），
    dev 文件静默回退普通取值。顶层为**数组**时语义不变（数组仍是对象：按数字下标可取，
    按键名取不到返回 `false`）。

19. **"中间件漏调 `next()`" 告警归因**（本次，修复）：判定条件原为"整条链没写出响应"，
    于是把"处理器无输出 → 补空 200"这条文档化的正常路径也算成了中间件的锅。实测
    `router.get('/empty', () => {})`（**一个中间件都没注册**）每条请求记一行 WARN，
    高 QPS 空体端点会在生产持续刷错日志。现由处理器执行前置 `ctx.dispatched`，
    **只有整条链没走到处理器**（某中间件既没 `await next()` 也没写响应）才告警；
    全局 / 分组 / 路由级任一中间件漏调 `next()` 都在覆盖范围内（判定与中间件注册在哪一层无关）。顺带修门槛：该告警原先嵌在 `emptyResponse: true`
    分支内，宿主关闭补空后同样的短路反而**完全静默**（响应永不写出、客户端挂到超时也无一行日志）；
    现告警与补空开关解耦，文案按是否补空分别为"已补空 200"与"emptyResponse 已关闭，未补空响应"。
    响应契约未变：`emptyResponse` 默认仍为 `true`，处理器无输出仍补空 200。

20. **响应状态码日志**（本次）：响应写出门面 `HttpRes`（全项目唯一出口）在写出后按状态码
    **首字符**记一行日志：`1` / `2` / `3` → INFO，`4` / `5` → WARN，其余前缀（6xx–9xx 等
    非标准码）不记。按字符串首字符判定而非数值区间，保留 4 位及以上自定义码（如 4999）
    按 4xx 处理的可能。文本格式为 `客户端IP 请求方式 响应代码 原始URL status描述`：
    请求方式归一为 `GET` / `POST` / `OTHER`；原始 URL 取 `req.url` 原文（含查询串与 hash，
    不做路径归一化）；status 描述优先取响应自带的 `statusMessage`，其次标准 reason phrase，
    无对应描述时输出 `No status message`。**凡经过该出口的响应都记**（含 404 / 405 /
    AppError / 500 兜底），不排除任何路径——500 兜底因此同时保留原有的 ERROR 日志与一条
    状态 WARN；写出本身失败（如非法状态码）时不记，此时实际返回客户端的是入口兜底出口
    写出的状态码。是否真正记录随所属 `HttpServer` 实例的日志等级阈值（生产默认 warn：
    1/2/3 丢弃、4/5 保留；开发 info 则全记）。此前 4xx/5xx 除 500 的 ERROR 日志外完全静默。

21. **`HttpClient` 同实例并发请求头隔离**（本次，修复）：`requireHttp` 此前把调用方传入的请求头
    经 `headerAdd` **合并回实例共享状态** `this.headers`，再据此发出请求，于是同一实例上并发的
    请求会互相带上对方的头——实测 `Promise.all([get(a, { 'X-Tenant': SECRET }), get(b, { Authorization: … })])`
    会让服务端在 `b` 上收到 `x-tenant: <SECRET>`，属**凭据跨请求泄漏**（原测试全部串行，零覆盖）。
    `post` / `put` 由 `dataType` 自动生成的 `Content-Type` 同样写进共享状态，会外溢到并发的其它请求
    （并发的无体 GET 会带上 `content-type: application/json`）。
    现改为：每次请求在入口处把"实例累积头（作默认值）+ 调用方头（覆盖）"合成为**本次请求私有**的
    头集合，全程不回写 `this.headers`；重定向各跳的 `Referer` 也只追加在这份私有集合上。
    自动 `Content-Type` 改由内部参数传递，且只在调用方未声明同名头时补上（大小写与原始行写法
    均算已声明，故 `{'content-type': 'text/csv'}` 与 `['Content-Type: …']` 都能覆盖自动值）。
    既有契约未变：`headerAdd` 仍是实例级默认头、请求结束（含失败）仍清空且不跨请求保留、
    `headers === null` 仍取累积头、数字键 / 数组项仍按 `"Name: value"` 原始行解析、
    调用方显式 `Content-Type` 仍优先于 `dataType` 自动值。
    用法约定随之写明：**单次凭据请走 headers 入参**，不要 `headerAdd` 进实例（那是共享状态）；
    `client.url` / `client.ssl` 只是排障观测值，并发下由最后写入者决定，某次请求的最终 URL
    取该次返回值的 `rawInfo.url`。

22. **config.json 告警原因脱敏**（本次，修复）：第 14 条的 WARN 原先把 `err.message` 原样写进
    `reason` 字段，而 `JSON.parse` 的 SyntaxError 消息**内嵌出错位置附近最多约 20 个字符的文件原文**
    （输入较短时甚至是全文）——实测 `DB_PASSWORD=S3cr3tP@ss!, {broken` 会记成
    `reason:"Unexpected token 'D', \"DB_PASSWOR\"... is not valid JSON"`，把口令键名前缀同时抄进了
    stdout 与日志文件，与同文件"不输出文件内容"的承诺相反。原测试用行尾逗号（`,}`）做夹具，
    那种形态走的是不含原文的 `Expected ... at position N` 分支，因此一直没暴露这条泄漏路径。
    现 `reason` 一律由调用方给出**确定不含内容**的文本：读取失败记 errno 码（`ENOENT` / `EACCES` /
    `EISDIR`，路径本就由 `file` 字段单独给出）、解析失败记固定的 `SyntaxError` 类别说明、
    顶层非对象记 `typeof`（不记值本身）。告警文案、去重语义与 `getConfig` 返回值均未变化。
    需要精确行列时请在受控终端里自行复现一次 `JSON.parse`，不要让库把配置内容写进共享日志。

23. **Logger 兜底路径不再炸宿主**（本次，修复）：两处实测缺陷。
    - **`fields` 序列化无保护**：`Logger.error('x', {peer: 循环引用})` 与 `{n: 10n}` 直接抛
      `TypeError`（`Converting circular structure to JSON` / `Do not know how to serialize a BigInt`），
      且因为序列化发生在写通道之前，**整条日志一行都没落**（stdout 与文件皆无）。Logger 正是
      `catch` / `onError` 的兜底路径，"记一条日志"变成炸宿主。现在快路径仍是原生 `JSON.stringify`
      （正常字段的输出逐字节不变），仅当它抛错时退到安全编码器：循环引用按**祖先链**判定
      （兄弟节点重复引用同一对象不会被误伤）→ `"[Circular]"`、`"[BigInt 10]"`、超 10 层
      `"[Truncated]"`、`toJSON` / getter 抛错 → `"[ToJSON threw]"` / `"[Getter threw]"`，
      输出恒为合法 JSON；字段改为逐键读取（原 `Object.entries` 会调 getter，一个坏 getter
      就连累其余好字段全丢）；连一行都构造不出来时退化为只含时间/等级/消息的兜底行。
      `Logger.now` 抛错或返回非法 `Date` 也退回真实时钟（否则写出 `NaN-NaN-NaN` 时间戳）。
    - **只在跨天首写建目录**：`Logger.logDir = 新目录` 后（日期未变）新目录永不被创建，
      往不存在的目录追加失败又被静默吞掉，**文件通道丢日志直到次日**（实测新目录不存在，
      而预先建好的目录正常写入）。滚动状态由此扩为「日期 + 目录」，`Config.setRootDir()`
      换宿主根（默认目录随之变化）同样覆盖；追加报缺目录时补建目录重试一次，覆盖运行期
      目录被外部删除的情形。清理改按刚写入的那个目录执行，且单个旧文件删不掉
      （Windows 常见 `EBUSY`）时跳过，不再打断滚动状态推进。
    公共 API、行格式与等级/目录配置语义均未变化（`Logger.cleanup()` 签名不变）。
24. **测试夹具避开 fetch 禁端口**（本次，仅测试）：`httpServer` 的用例普遍用 `listen(0)` 让系统
    分配端口，再用全局 `fetch()` 打真实请求。而 WHATWG Fetch 带有一份 **port block list**，
    `fetch()` 在建连之前就会拒绝它（`TypeError: fetch failed`，`cause: bad port`），
    清单里的 `1719 / 2049 / 3659 / 4045 / 5060 / 5061 / 6000 / 6566 / 6665–6669 / 6697 / 10080`
    都落在本机 Windows 的临时端口区间内（`netsh int ipv4 show dynamicport tcp` 实测
    起始 1024、共 13977 个）——于是系统偶尔把禁端口分给测试服务，表现为 `server.test.js`
    随机红掉一两个用例，且每次红的用例不同（同一份代码连跑 6 次约中 1 次，与被测代码无关）。
    现在三处真实监听统一走 `test/httpServer/fetchPortFixture.js` 的 `listenOnFetchablePort`：
    抽中禁端口就 `close()` 后重新 `listen(0)`（系统的分配计数器会向前走，一两轮即越过），
    刻意不改用固定端口——固定端口会带来占用与并行冲突。只有走全局 `fetch()` 的用例受影响，
    `http.request` 与 `HttpClient`（`node:https`）都不查这份清单，故产品代码零改动。
    夹具自带 5 例自检（清单成员与端口可用性实测断言、重试时逐个关闭、连续失败明确报错），
    防止它悄悄退化成"看起来在做事的空转"。

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

## 出站 HTTPS 与 CA

Node.js 默认**自动校验证书链**，并在二进制中内置 Mozilla 根 CA 列表，因此访问公共
HTTPS 站点**不需要**自带 CA 文件，本库不配置 `CA/cacert.pem` 时即走系统 CA。只有目标
站点使用**私有 / 自签名 CA**（内网服务、自建网关、抓包代理根证书）时才需要提供：

```js
HttpClient.caFilePath = '/etc/ssl/private-ca.pem';  // 下次 HTTPS 请求即生效
```

三个容易踩的点：

- `https.Agent` 的 `ca` 是**替换**内置根证书列表，不是追加——该文件只放需要额外信任的私有 CA；
- 若想"追加"而非替换，用环境变量 `NODE_EXTRA_CA_CERTS=<path>`（Node 启动时读取）；
- **同一路径下替换了证书内容**需 `HttpClient.closeAgents()` 才会重新读取（换路径则自动重载）。

## 验收

```
pnpm check    # tsc 静态类型检查，exit 0
pnpm test     # node:test 全量
```

发布前守门：`prepublishOnly` 会在 `npm publish` 时自动跑 `npm run check && npm run test`
（`npm publish --dry-run` 同样触发），任一失败即中止发布。它**不**在 `npm install`
或 `npm pack` 时运行，不影响日常开发；可用 `npm publish --ignore-scripts` 绕过（防手滑，不防恶意）。

测试脚本是 `node --test "test/*.test.js" "test/**/*.test.js"`，两个模式都**必须保留**：

- `test/**/*.test.js` 在 **bash 默认（`globstar off`）下 `**` 等同于 `*`**，展开后只覆盖
  `test/httpServer/`，会**静默漏掉 `test/` 顶层的 7 个测试文件**（17 → 10 个文件）；
- 加上 `test/*.test.js` 后，无论 glob 由 Node 自己展开还是被 shell 展开，结果都一致；
- 不要改成 `node --test`（无参数）：Node 的自动发现会把 `test/` 下的**夹具文件**
  （`contextFixture.js` / `loggerFixture.js`）也当成测试文件执行。

真实数据库/SMTP 的连通性由项目所有者在部署环境验证（本库不含这两类组件）。

## 许可证

[MIT](./LICENSE)
