# httpServer 框架

入站 HTTP 服务端框架的完整行为约定：装配入口、路由模板、中间件、请求/响应门面与日志。
概览与最短可用示例见 [README](../README.md)。

```js
import { HttpServer, Router, HttpReq, HttpRes, AppError, Middleware, Logger } from '#YukiLib/httpServer';

const router = new Router({ basePath: '/api' });
router.use(Middleware.cors());
router.use(Middleware.requestId());
router.use(Middleware.accessLog());

router.get('/v1/users/{uid:int}', ({ uid }) => ({ uid }));

router.group('/v1/admin', (admin) => {
    admin.use(async (ctx, next) => {
        if (!HttpReq.getCookie('token', 'string')) throw new AppError('未登录', 401);
        await next();
    });
    admin.get('/overview/{section}', (params, ctx) => {
        HttpRes.header('X-Trace-Id', ctx.requestId);
        return HttpReq.getQuery('detail', 'bool', false) ? params : { section: params.section };
    });
});

HttpServer.create({ router, serviceName: 'example-service', logLevel: 'info' })
    .listen(8000, '127.0.0.1', () => Logger.info('服务已启动'));
```

## HttpServer

`HttpServer.create(options)` → 实例；`listen(port?, host?, callback?)` 启动并返回自身（可链式），
`await close()` 主动关闭。属性：`port`（实际监听端口，`listen(0)` 后为系统分配值）、`logger`
（本实例的 `ServerLogger`，可运行期改 `server.logger.level`）。

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `router` | 必填 | `Router` 实例 |
| `serviceName` | `'http-server'` | 服务名（404/405 响应体 `name` 字段与日志字段） |
| `host` / `port` | `'127.0.0.1'` / `8000` | 省略 `listen` 参数时使用 |
| `bodyLimit` | `1048576` | 请求体上限（字节），超限 413 |
| `headersTimeout` / `requestTimeout` / `keepAliveTimeout` | `60000` / `300000` / `5000` | 毫秒 |
| `emptyResponse` | `true` | 处理器无输出时补空 200 |
| `gracefulShutdown` | `true` | 注册到进程级信号注册表，SIGINT/SIGTERM 时优雅关闭 |
| `exitOnShutdown` | `false` | 关闭完成后是否结束进程（仅当所有已注册实例均为 `true` 才 `process.exit`） |
| `shutdownTimeout` | `10000` | 到点强制断开剩余连接 |
| `logLevel` | 跟随 `Logger` 默认 | `info` / `warn` / `error` |
| `onError` | `null` | 异常钩子（含 `AppError`） |

优雅关闭由**进程级共享注册表**承载：每进程只装一组信号监听器，`listen` 时注册、`close` 时注销，
一次信号关闭全部已注册实例。宿主自行接管信号时把 `gracefulShutdown` 设为 `false`。

### 执行顺序与兜底出口

```
全局中间件（router.use） → 路由决策 → 分组/路由级中间件 → 处理器
```

全局中间件**先于**路由决策，因此 404 / 405 也经过它（CORS 预检、全局鉴权、访问日志得以覆盖
未命中与方法不符的请求；`Middleware.cors()` 的 OPTIONS 预检因此能短路返回 204，而不是被 405 拒掉）。
分组中间件与 `options.middleware` 只作用于命中路由。

五条兜底分支（全项目唯一出口是 `HttpRes`）：

| 情形 | 输出 |
| --- | --- |
| 未命中路径 | 404 `{ name, status: '404 not found', path, method }` |
| 路径命中、方法不符 | 405 同形状 + `Allow` 头 |
| `AppError`（含参数校验失败、路径参数越界） | `statusCode` + `{ status: message }` |
| 未捕获异常 | 记 error 日志（堆栈只进日志）+ 500 `{ status: '服务器内部错误' }` |
| 响应已开始后异常 | 只记日志并 destroy 响应（客户端立即得到连接中断） |

处理器签名 `(params, ctx)`：`params` 是已按模板类型转换的路径参数。返回值非 `undefined`
即自动经 `HttpRes.jsonRes` 输出 JSON 200；无任何输出时补空 200（属文档化的正常路径，不记日志）。
只有整条链没走到处理器（某中间件既没 `await next()` 也没写响应）才记 WARN。
中间件签名 `(ctx, next)`：`await next()` 前后分别为请求前/后处理。

### 响应契约

- JSON 体：4 空格缩进、斜杠与非 ASCII 不转义（等价 PHP
  `json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)`）；
- 错误体统一 `{ "status": message }`；404 / 405 维持 `{ name, error, path, method }`；
- 无响应体形态（`jsonRes(null)` / `fastResEmpty(code)` / `fastResRedirect(url, code)`）只写状态码与
  附加头，**不设 Content-Type、不写响应体**；这与"省略 `data` 参数"（值为 `undefined`）不同，
  后者仍设 Content-Type 且写出空体（HEAD 声明 `Content-Length: 0`，与 GET 的头保持一致）；
- HEAD 命中 GET 路由：响应头照常写出、响应体自动抑制；
- 响应修饰（`header` / `cookie` / `status`）必须在写出之前调用。

## Router

`new Router({ routes, basePath, trailingSlash, types })`。方法：`get` / `post` / `put` / `patch` /
`delete` / `any` / `map(method, route, target, options)`、`group(prefix, cb)`（可嵌套）、
`use(...middlewares)`、`addRoutes(routes)`、`addMatchTypes(types)`、`setBasePath(basePath)`、
`getRoutes()`、`match(url, method)`、`compileRoute(route)`、`generate(name, params, options)`。
`options` 可为路由名字符串，或 `{ name, middleware }`。

- 匹配按注册顺序，先注册先命中；
- `trailingSlash` 默认 `'ignore'`（`'strict'` 关闭）；`basePath` 用于应用位于子目录；
- 路径归一化：补齐首斜杠、折叠两个及以上连续斜杠、剥离尾部斜杠；
- `map` 的方法声明以 `|` 分隔、大小写不敏感；空白与重复方法容错（`' get | post '` →
  `['GET','POST']`，`'GET|GET'` → `['GET']`）；`*` 必须独占，并在注册期展开为 `HTTP_METHODS`
  （GET / HEAD / POST / PUT / PATCH / DELETE / OPTIONS / TRACE / CONNECT）。因此 `any()` 对
  `PROPFIND` 等非标准动词返回 405 + `Allow`，自定义动词请显式 `map('PROPFIND', ...)`；
- 注册期校验（中文消息，启动即暴露）：非法/重复参数名、无法解析的占位符、未知类型、
  空或非法方法声明、正则编译失败（原始异常留在 `cause`）。

### 模板语法

| 写法 | 含义 |
| --- | --- |
| `{name}` | 字符串段（不含斜杠） |
| `{name:type}` | 指定类型段 |
| `{name?}` / `{name:type?}` | 可选段（缺失时该键不进 `params`） |
| `{}` | 匿名段（参与匹配、不进 `params`；注意 `{int}` 是名为 `int` 的 string 段，指类型须带冒号） |
| `@` 前缀 | 整条按自定义正则匹配（命名组进 `params`，数字组丢弃，缺锚定时自动补 `^...$`） |
| 整条为 `*` | 通配全部路径（模板内的 `*` 是字面量） |

内置类型（正则片段，`addMatchTypes` 可追加/覆盖）：`int` `[0-9]+`、`float`
`[0-9]+(?:\.[0-9]+)?`、`bool` `(?:true|false)`、`string` `[^/]+`、`hex` `[0-9A-Fa-f]+`、
`alpha` `[0-9A-Za-z]+`、`path` `.+?`（跨斜杠、非贪婪、至少一字符）、`all` `.+`（跨斜杠含尾斜杠）。

参数名须是标识符、同一条模板内唯一，且不能是 `__proto__`。占位块之外的部分（含 `group()`
前缀与块后缀 `/report.{id:int}.pdf`）是**路径字面量**：正则元字符编译时自动转义，`.` 不充当
通配符；`@` 模式与自定义类型片段仍按正则解析。

> **安全红线**：`@` 正则与 `addMatchTypes` 片段必须是静态、由开发者编写的字符串，禁止拼接请求数据。
> 同步正则一旦灾难性回溯会占满事件循环。正则源超 1024 字符注册即抛错；疑似嵌套量词
> （`(a+)+`）仅记 WARN、不阻断注册（该启发式存在误报）。

### 路径参数类型转换

`int` / `float` 只有在 double 能**精确表示** URL 里的十进制文本时才转成 number，否则 `match`
返回 `status: 'badParam'`（附 `badParam: { name, type }`，不回显 URL 原文），由 `HttpServer` 经
AppError 出口给出 400 `{ "status": "路径参数 id 不是合法的 int" }`。否则
`/user/99999999999999999999` 与 `/user/99999999999999999998` 会同时得到 `1e20`，构成鉴权/查库的混淆面。

- 不改变数值的收敛是保留行为：`/user/007 → 7`、`/f/1.0 → 1`；
- 判定标准是"无损"而非"安全整数"：`9007199254740992` 放行、`9007199254740993` 被舍入故拒绝；
- 需要原始文本就声明 string 段（`/user/{id}`）；
- 定夺优先级 `hit > methodNotAllowed > badParam > notFound`，越界不阻断后续路由命中
  （后面还有 `/user/{id}` 或 `*` 兜底时照常 200）。

自行调用 `router.match()` 的宿主需处理 `badParam` 状态（其 `target` 为 `null`）。

### 反向路由

`generate(name, params, { encode })` 默认对参数值做 URL 编码（`{path:path}` / `{rest:all}` 按段编码、
保留斜杠），`{ encode: false }` 可关闭；`@` 自定义正则路由不支持反向生成。手工拼 URL 用
`encodeUrlParam(value, { keepSlash })`，与 `generate` 同一套编码规则。

## 请求体与取值

请求体两种来源，**取值写法完全一致**：

| `Content-Type` | 解析器 | `HttpReq.getPostData` 校验语义 |
| --- | --- | --- |
| `application/json`（或未声明） | `parseJsonBody` | 严格：`int` 要求 JSON 数字、`bool` 要求布尔值 |
| `application/x-www-form-urlencoded` | `parseFormBody` | 字符串来源：`'42'` 可取 `int`、`'true'` 可取 `bool`（与 `getQuery` 一致） |

- 表单同名键取**首个**值（与 `getQuery` 一致）；`+` 视作空格、百分号解码、非法编码原样保留；
  无 `=` 的片段（如 `flag`）按空串收录；
- `getBody()` 在表单来源下返回字符串值对象，需要类型转换请用 `getPostData` 声明类型；
- 空体/纯空白一律按空对象处理；合法但非对象/数组的标量按空对象处理；
- 非 JSON 且非表单的 `Content-Type` 仍按 JSON 解析（非法即 400）。

### HttpReq

静态门面，读当前请求上下文：`getPostData` / `getQuery` / `getParam` / `getHeader` / `getCookie`
（签名均为 `(name, type = 'none', default?)`）、`getIp()` / `getRawBody()` / `getBody()` /
`getMethod()` / `getPath()` / `getRequestId()` / `current()`。

字段不存在（或值为 `null`）时：显式传入默认值则返回默认值，否则抛 `AppError('参数错误', 400)`；
字段存在但类型不符时始终抛错（默认值不生效）。

**取值类型保证**：声明了 `type` 的取值一律返回该类型；字符串来源（表单体 / query / param /
header / cookie）按字符串来源语义强转；值缺失时返回显式缺省值，未显式传则返回该类型零值。

| `type` | 返回类型 | 缺失时的零值 |
| --- | --- | --- |
| `string` / `none` / 其它 | string / 原值 | `''` |
| `int` / `float` | number | `0` |
| `bool` | boolean | `false` |
| `array` | array（JSON 对象一并接受，结构语义） | `[]` |

```js
const uid = HttpReq.getCookie('uid', 'int');      // number；cookie 缺失 → 0
const vip = HttpReq.getHeader('x-vip', 'bool');   // boolean；头缺失 → false
const page = HttpReq.getQuery('page', 'int', 1);  // number；缺省值优先于零值
```

`getHeader` / `getCookie` 的第二参是 `type`（默认 `none`），非已知类型名时按缺省值处理
（兼容旧写法 `getCookie('sid', 'def')`）；`'none'` 等已知类型名会被当作类型声明，缺省值请用第三参。

后续项：`getQuery` / `getParam` 的 `int` 仍走 `Number(value)`，`?id=99999999999999999999` 会塌缩成
`1e20`；该门面语义是"校验不过即 400"，收口方式与路由不同，需单独评估。

## HttpRes

静态门面，写当前请求上下文：`jsonRes(data, httpCode?, headers?)`、`fastResEmpty(httpCode?)`、
`fastResRedirect(url, httpCode = 307)`、`fastResError(message, httpCode)`（抛 `AppError`，交由兜底出口）、
`status(httpCode)`、`header(name, value)`、`cookie(name, value, options)`。
`jsonRes` / `fastResEmpty` 省略 `httpCode` 时沿用当前状态码，故 `status(201)` 之后 `jsonRes(data)`
不会把状态码打回 200；`fastResRedirect` 不终止控制流，需自行 `return`。

每次写出后按状态码**首字符**记一行响应状态日志：`1` / `2` / `3` → INFO，`4` / `5` → WARN，
其余前缀（6xx–9xx 等自定义码）不记。按首字符而非数值区间判定，保留 4 位及以上自定义码
（如 `4999`）按 4xx 处理的可能。文本格式为 `客户端IP 请求方式 响应代码 原始URL status描述`：
方法归一为 `GET` / `POST` / `OTHER`；原始 URL 取 `req.url` 原文（含查询串，不做路径归一化）；
描述优先取 `statusMessage`，其次标准 reason phrase，无对应描述输出 `No status message`。
凡经该出口的响应都记（含 404 / 405 / AppError / 500 兜底）；是否真正落盘随所属 `HttpServer`
实例的日志等级阈值（生产默认 warn：1/2/3 丢弃、4/5 保留）。写出本身失败时不记。

## 内置中间件

`Middleware` 为 opt-in，默认不启用，需显式 `router.use(...)`。

| 工厂 | 作用 | 选项与默认值 |
| --- | --- | --- |
| `cors(options)` | 跨域头 + OPTIONS 预检短路（204，不进处理器） | `origin: '*'`、`methods`（GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS）、`headers`（Content-Type, Authorization, X-Request-Id）、`credentials: false`、`maxAge: 86400`、`preflight: true` |
| `accessLog()` | 响应 `finish` 时输出一行访问日志（状态码为最终值，异常路径同样记录） | 等级随所属实例的 `logLevel` |
| `requestId(options)` | 把请求标识回写响应头，便于前后端与日志关联 | `header: 'X-Request-Id'` |

`credentials: true` 时必须显式指定非 `'*'` 的 `origin`，否则构造时抛 Error（避免"任意站点可携带
凭证调用本 API"）。`origin !== '*'` 时自动追加 `Vary: Origin`，不覆盖宿主已设的 `Vary`。

## 请求上下文

`context` 子路径导出 `runWithContext(ctx, handler)`（框架内部使用）、`getCurrentContext()`、
`tryGetCurrentContext()`。上下文由 `HttpServer` 在请求入口建立、请求结束自动失效，
并发请求各自独立。在上下文之外调用门面会抛明确错误，不会静默返回脏数据
（定时任务里误用 `HttpReq.getPostData` 会立即失败）。

`ctx` 字段：`req` / `res`（原始对象）、`method`、`path`（归一化后）、`params`、`query`
（`URLSearchParams`）、`body`、`rawBody`、`requestId`、`state`（中间件共享状态，约定键名避免互踩）、
`logger`（请求级日志）。

> 禁忌：在 `runWithContext` 之外创建、且请求结束后才触发的定时器/回调不属于任何请求上下文。
