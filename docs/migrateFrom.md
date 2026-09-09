# 迁移与兼容性记录

本库迁移自某内部项目，此后按域重组、框架化。除下列条目外行为与原实现一致
（原测试用例全部保留并通过）。日常使用请读 [README](../README.md)；
httpServer 的完整行为约定见 [docs/httpServer.md](./httpServer.md)。

## 旧 API → 新 API

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

## 与抽出前实现的差异

1. **宿主根解析**：不再由库自身文件位置（`import.meta.url`）反推，改为四级优先级：
   `Config.setRootDir()` → `YUKI_PROJECT_ROOT` → 入口脚本向上最近含 `package.json` 的目录 → `process.cwd()`。
2. **`Logger.logDir`**：默认值改惰性解析（`Config.resolveFromRoot('log')`），因此在
   `Config.setRootDir()` 之后导入或使用同样生效；显式赋值仍可重定向。
3. **`HttpClient` CA**：新增 `HttpClient.caFilePath`（默认宿主根下 `CA/cacert.pem`）；文件缺失时
   回退系统 CA，不再抛 `ENOENT`；改路径会在下次 HTTPS 请求自动重载并重建 Agent（无需手动
   `closeAgents()`），但同一路径下替换证书内容仍需 `closeAgents()`。`https.Agent` 的 `ca` 是
   **替换**内置根证书而非追加，该文件只放需额外信任的私有 CA。
4. **内部引用**：库内一律相对路径（`./config.js`）；对外提供子路径导出与 `#YukiLib/*` 别名。
5. **JSON BOM 容忍**：`config.json` / `dev.config.json` 行首 UTF-8 BOM 会被剥离（Windows 记事本、
   PowerShell 5.1 写出的文件常带 BOM，原实现会静默解析失败、取值全为 `false`）。
6. **目录按域重组**：源码根改为 `src/`；`appError` / `requestJson` / `router` 归入 `src/httpServer/`，
   子路径相应改为 `ysyuki-lib-on-nodejs/httpServer/*`，并新增子域入口 `.../httpServer`。
   旧的 `.../appError`、`.../requestJson`、`.../router` 子路径**不再提供**（宿主需同步改造）；
   类名、行为与响应契约均未变。
7. **httpServer 框架化（破坏性）**：`RequestJson` 拆为 `HttpReq`（请求侧取值）+ `HttpRes`（响应侧输出），
   基于 `AsyncLocalStorage` 的请求上下文，类名与子路径均变更；路由改为 FastAPI 风格 `{id}` /
   `{id:int}` 模板（取代 `[i:id]`），新增分组 `group()`、中间件洋葱、405（带 `Allow`）、HEAD→GET、
   路径参数按类型转换；新增 `HttpServer` 入口与 `Middleware`（opt-in）。`ServerLogger` 只是
   `Logger` 的服务器场景包装。保持不变的契约：JSON 序列化格式、`{status: message}` 错误体、
   校验失败 400、404/405 响应体形状、类型系统（`array` 仍兼收对象）。
8. **路由正则护栏**：`@` 自定义正则缺锚定时自动补 `^...$`（此前遗漏会变成子串匹配）；正则源超过
   1024 字符注册即抛错；疑似灾难性回溯（嵌套量词）仅记 warn、不阻断注册。`@` 正则与
   `addMatchTypes` 片段必须是静态、由开发者编写的字符串，禁止拼接请求数据。
9. **反向路由编码（破坏性）**：`Router.generate()` 默认对参数值做 URL 编码（`{path:path}` /
   `{rest:all}` 按段编码、保留斜杠），可用 `{ encode: false }` 关闭；新增 `encodeUrlParam(value, { keepSlash })`；
   `@` 自定义正则路由不再支持反向生成（此前会静默返回正则源字符串）。
10. **表单请求体**：新增 `application/x-www-form-urlencoded` 解析（`parseFormBody`），`getPostData`
    按请求体来源选择校验语义（JSON 严格 / 表单字符串强转），调用写法不变；此前表单请求会被
    当非法 JSON 直接 400。同名键取首值，与 `getQuery` 一致。
11. **取值类型保证**：`getHeader` / `getCookie` 新增 `type` 位（默认 `none`），与 `getQuery` / `getParam`
    一致地按声明类型返回；值缺失且未传缺省值时返回该类型零值。第二参非已知类型名时仍按缺省值
    处理（兼容旧写法），但 `'none'` 等已知类型名不再能作为缺省值字面量。
12. **超限请求体与路径折叠**：请求体超限（413）后剩余数据会被读掉，keep-alive 连接可继续复用
    （此前复用会 ECONNRESET）；`normalizePath` 折叠两个及以上连续斜杠（此前只折叠一次，
    `//a///b/` 会残留 `//`）。
13. **兜底出口**：响应已开始后发生异常时 destroy 响应，客户端立即收到连接中断
    （此前只记日志，客户端会一直等到 `requestTimeout`）。
14. **config.json 不可用告警**：`config.json` 缺失或解析失败时 `getConfig` 仍返回 `false`（行为不变），
    但会经 `Logger.warn` 记录一次警告；同一宿主根只告警一次，`setRootDir()` 重置。此前完全静默，
    配置未生效却无从察觉。（"不输出文件内容"这一承诺最初被 `reason` 破坏，见第 22 条。）
15. **默认等级缓存**：`Logger.defaultLevel` 的 dev 判定按开发配置路径缓存，写日志不再每条同步
    `existsSync`（实测 8.56µs/条 → 0.37µs/条）。`Config.setRootDir()` / 给 `Config.devConfigFile` 赋值
    自动失效；同一路径上增删 `dev.config.json` 需显式 `Logger.resetDevCache()`。
16. **全局中间件先于路由决策（行为变更）**：此前路由匹配（含 404/405）先执行、全局中间件只在命中
    路由时运行，导致 `Middleware.cors()` 的 OPTIONS 预检被 405 拒掉，真实浏览器跨域请求直接失败。
    现全局中间件包裹路由决策，404/405 也经过它；分组/路由级中间件仍只作用于命中路由。
    顺带：HEAD 响应补 `Content-Length`（与 GET 一致）；中间件漏调 `next()` 记 WARN。
17. **路由块外字面量转义（修复）**：占位块之外的部分此前被原样拼进匹配正则，于是按正则语义生效
    （`.` 成通配符，实测 `/a.b/{id:int}` 命中 `/axb/7`，`+` `(` `|` 同理）。现按纯文本处理：编译时
    转义 `[.*+?^${}()|[\]\\]`，`group()` 前缀与块后缀（`/report.{id:int}.pdf`）一并生效。
    `@` 自定义正则与 `addMatchTypes` 片段仍按正则解析、不转义；`generate()` 输出的仍是 URL 字面量。
18. **顶层非对象容错（修复）**：`config.json` / `dev.config.json` 内容整体是 `null`（或数字 / 字符串 /
    布尔）时 `JSON.parse` **成功**并返回非对象值，此前 `getConfig` 会抛 `TypeError`，且缓存被写成 `null`、
    `isConfigLoaded` 被误置为"已加载"。现与"解析失败"同等对待：不写缓存、不置已加载、一律返回 `false`；
    `config.json` 照旧记一次 WARN（原因写明"内容不是对象"），dev 文件静默回退普通取值。
    顶层为**数组**时语义不变（数组仍是对象：按数字下标可取）。
19. **"中间件漏调 `next()`" 告警归因（修复）**：判定条件原为"整条链没写出响应"，于是把"处理器无输出
    → 补空 200"这条文档化的正常路径也算成中间件的锅（实测一个中间件都没注册的 `() => {}` 端点
    每条请求记一行 WARN）。现由处理器执行前置 `ctx.dispatched`，只有整条链没走到处理器才告警
    （全局 / 分组 / 路由级任一中间件漏调都在覆盖内）。顺带把告警与 `emptyResponse` 开关解耦
    （原先嵌在补空分支内，宿主关闭补空后同样的短路反而完全静默）。响应契约未变：默认仍补空 200。
20. **响应状态码日志**：写出门面 `HttpRes` 在写出后按状态码**首字符**记一行日志：`1` / `2` / `3` → INFO，
    `4` / `5` → WARN，其余前缀不记（按首字符判定可保留 4 位及以上自定义码按 4xx 处理的可能）。
    凡经该出口的响应都记（含 404 / 405 / AppError / 500 兜底），是否落盘随实例日志等级阈值。
    此前 4xx/5xx 除 500 的 ERROR 日志外完全静默。文本格式与细节见 docs/httpServer.md。
21. **`HttpClient` 同实例并发请求头隔离（修复）**：`requireHttp` 此前把调用方请求头经 `headerAdd`
    合并回实例共享状态 `this.headers`，于是同一实例并发的请求会互相带上对方的头（实测租户密钥
    出现在另一请求上），属**凭据跨请求泄漏**；`dataType` 自动生成的 `Content-Type` 同样外溢。
    现每次请求在入口处把"实例累积头（作默认值）+ 调用方头（覆盖）"合成为**本次请求私有**的头集合，
    全程不回写 `this.headers`；重定向各跳的 `Referer` 也只追加在这份私有集合上。自动 `Content-Type`
    仅在调用方未声明同名头时补上（大小写与原始行写法均算已声明）。既有契约未变：`headerAdd` 仍是
    实例级默认头、请求结束（含失败）仍清空、`headers === null` 仍取累积头、数字键 / 数组项仍按
    `"Name: value"` 原始行解析。用法约定：**单次凭据走 `headers` 入参**，不要 `headerAdd` 进实例；
    `client.url` / `client.ssl` 只是排障观测值（并发下由最后写入者决定），某次请求的最终 URL 取
    该次返回值的 `rawInfo.url`。
22. **config.json 告警原因脱敏（修复）**：第 14 条的 WARN 原先把 `err.message` 原样写进 `reason`，
    而 `JSON.parse` 的 SyntaxError 消息**内嵌出错位置附近最多约 20 个字符的文件原文**（输入较短时
    甚至是全文），实测会把口令键名前缀同时抄进 stdout 与日志文件，与"不输出文件内容"的承诺相反
    （原测试用行尾逗号做夹具，那种形态不含原文，因此一直没暴露）。现 `reason` 一律由调用方给出
    **确定不含内容**的文本：读取失败记 errno 码、解析失败记固定的 `SyntaxError` 类别说明、
    顶层非对象记 `typeof`（不记值）。告警文案、去重语义与 `getConfig` 返回值均未变。
23. **Logger 兜底路径不再炸宿主（修复）**：
    - `fields` 里的循环引用 / `BigInt` 此前直接抛 `TypeError`，且序列化发生在写通道之前，
      **整条日志一行都没落**。Logger 正是 `catch` / `onError` 的兜底路径，"记一条日志"变成炸宿主。
      现快路径仍是原生 `JSON.stringify`（正常字段输出逐字节不变），仅当它抛错时退到安全编码器：
      循环引用按祖先链判定 → `"[Circular]"`、`"[BigInt 10]"`、超 10 层 `"[Truncated]"`、
      `toJSON` / getter 抛错 → `"[ToJSON threw]"` / `"[Getter threw]"`，输出恒为合法 JSON；字段改为
      逐键读取（一个坏 getter 不再连累其余字段）；连一行都构造不出来时退化为只含时间/等级/消息的
      兜底行。`Logger.now` 抛错或返回非法 `Date` 退回真实时钟。
    - 原先**只在跨天首写建目录**：`Logger.logDir` 指向新目录后（日期未变）该目录永不被创建，
      追加失败被静默吞掉，**文件通道丢日志直到次日**。滚动状态由此扩为「日期 + 目录」，
      `Config.setRootDir()` 换宿主根同样覆盖；追加报缺目录时补建重试一次（覆盖运行期目录被外部删除）。
      清理改按刚写入的那个目录执行，单个旧文件删不掉（Windows 常见 `EBUSY`）时跳过。
    公共 API、行格式与等级/目录配置语义均未变化（`Logger.cleanup()` 签名不变）。
24. **测试夹具避开 fetch 禁端口（仅测试）**：用例普遍 `listen(0)` 后用全局 `fetch()` 打真实请求，
    而 WHATWG Fetch 带 port block list，`fetch()` 在建连前就拒绝它；清单中的若干端口落在 Windows
    临时端口区间内，导致偶尔随机红掉一两个用例（与被测代码无关）。现三处真实监听统一走
    `test/httpServer/fetchPortFixture.js` 的 `listenOnFetchablePort`（抽中禁端口就关闭后重听，
    刻意不改用固定端口以免占用与并行冲突）。只有走全局 `fetch()` 的用例受影响，`http.request` 与
    `HttpClient` 不查这份清单，产品代码零改动。
25. **路由参数值、通配方法与模板语法的注册期收口（含两条破坏性变更）**：
    - **`int` / `float` 路径参数不再塌缩**：`convertParam` 原先无条件 `Number(value)`，于是
      `/user/…99` 与 `/user/…98` 都得到 `1e20`、310 位数字得到 `Infinity` 且 `status=hit`
      （不同 URL → 同一参数值，是鉴权与查库的混淆面）。现只在 double 能精确表示原文时才转 number，
      否则 `match` 返回新增的 `status: 'badParam'`，由 `HttpServer` 经 AppError 出口给 400。
      `007 → 7`、`1.0 → 1` 这类不改变数值的收敛按保留行为（判定标准是"无损"，不是"安全整数"）。
      定夺优先级 hit > methodNotAllowed > badParam > notFound，且越界不阻断后续路由命中。
      **破坏性**：自行调用 `router.match()` 的宿主必须处理新状态（其 `target` 为 `null`）。
    - **`any()` / `map('*')` 展开为标准方法集合**：`*` 原先等于"接受任意方法"，405 对通配路由永不触发。
      现注册期展开为 `HTTP_METHODS`，非标准动词得到 405 + 具体 `Allow`；`route.methods` 不再含 `*`
      （`getRoutes()` 可见形状变化）。自定义 / WebDAV 动词请显式 `map('PROPFIND', ...)`。**破坏性**。
      边界：`BLOB` 这类解析器不认的动词在 socket 层已被 Node 判 400，进不到路由；`CONNECT` 走
      `connect` 事件，任何情况下都不进入 `request` 分发。
    - **方法声明注册期校验**：`map('')` / `map('|')` 会注册出永不命中的死路由；`'GET POST'`、
      `'GET,POST'`（分隔符写错）被当成**一个**方法名，既不命中又会在 405 里输出 `Allow: GET POST`
      并吞掉本应的 404；`'GET|*'` 让前半段形同虚设。现三种都在注册时抛中文错误（分段空白与重复
      方法仍容错，`Allow` 头不再重复）。
    - **模板语法注册期校验**：`{a-b:int}`、`{id:int}/{id:int}` 原先把名字直接拼进 `(?<name>)`，由
      `new RegExp` 抛**英文** `SyntaxError`（启动即崩、看不出是哪条路由）；`{v:}`（少写类型名）被整段
      当字面量编成永不命中的路由，注册期零告警、运行期永远 404。现参数名须为标识符、同一条模板内
      唯一、不能是 `__proto__`；含配对花括号却没解析成占位块的片段直接抛错；正则编译失败统一包成
      中文错误（原始异常留在 `cause`）。边界保留：块外的 `}` 与"只有 `{` 而无配对 `}`"仍按字面量，
      `{}` 仍是匿名段（`{int}` 是名为 `int` 的 string 段）。
    - 顺带收口三个同类静默陷阱：`addMatchTypes` 拒绝空片段（`(?<v>)` 会匹配空串）与模板里根本写不出
      来的类型名；`@` 正则里的 `(?<__proto__>…)` 命名组改由 `defineProperty` 落键（原先整段值被原型
      setter 吞掉）；`new Router({ routes, types })` 里 `types` 现先于 `routes` 生效。
    - 未变：404 / 405 响应体形状与 `Allow` 格式、HEAD→GET、`generate` 反向路由与编码、块外字面量转义、
      `@` 模式锚定与长度/回溯护栏。
    - 后续项（未动）：`HttpReq.getQuery` / `getParam` 的 `int` 走同一套 `Number(value)`，存在同类塌缩
      （`?id=99999999999999999999` → `1e20`）；该模块语义是"校验不过即抛 400"，收口方式与路由不同，
      需单独评估。
26. **`HttpClient` 重定向协议白名单与失败原因兜底（含一条行为收紧）**：
    - **跳转协议白名单**：`Location` 解析出的协议从不校验，而 `requestOnce` 的 `options.protocol`
      只按"这一跳是不是 https"二选一地**改写**协议，于是 `Location: gopher://127.0.0.1:<port>/probe`
      会被当**明文 HTTP** 发到那个 host:port（实测服务端照常返回 `200 PROBE HIT`，`rawInfo.url` 还谎报
      为 `gopher://…`）——等于给调用方一个"任意内网 host:port 探活"的原语；大写 `GOPHER://` 同样命中，
      `file:///C:/…` 与 `data:text/html,…` 则因 `hostname` 为空退化成连 localhost:80。现解析出下一跳后
      先校验协议（校验前置于 `Referer` / 计数 / 方法降级等状态变更），不在白名单内直接抛错；
      `requestOnce` 另设一道与配置无关的传输层不变量（非 http/https 即拒绝建连），协议判定与实际
      发出请求的库从此同源。新增 `HttpClient.allowedRedirectProtocols`（默认 `['http:', 'https:']`，
      接受数组 / `Set` / 逗号或空白分隔字符串，`http`、`HTTPS`、`https://` 统一归一为 `https:`；
      赋 `null` 恢复默认，`[]` 表示不跟随任何跳转；**只能收窄不能放宽**，出现 http/https 之外的协议
      在赋值时即抛中文错误；getter 返回副本）。白名单只作用于跳转，初始 URL 不受影响。
      **行为收紧**：跳转协议不受支持由"照旧发出被改写的请求"变为抛错；与"无 `Location` / 超过 10 次
      上限仍原样返回该 3xx"有意不同（那是没有可跟的跳转）。异常只回显**协议名**，不回显 `Location`
      原文（其中可能带签名令牌/敏感路径，同第 22 条的理由）。
    - **`HTTP Request Failed: ` 后无内容**：包装层直接取 `cause.message`，而 node 多地址连接失败
      （`localhost` 同时解析出 `::1` 与 `127.0.0.1` 且全部被拒）抛的是 happy-eyeballs 的
      **`AggregateError`**——`message` 是**空串**，信息只在 `code` 与 `errors[]` 里，实测只剩一个光秃秃的
      前缀（这条不限于漏洞路径，任何双栈主机连不上都是这个形状）。现由 `describeError()` 兜底：
      `message` → `errors[]` 明细（必要时冠以 `code`）→ `code` → `${name}（无错误信息）`，保证前缀后
      **必有非空可行动原因**；原始异常仍原样留在 `cause`。
    - 未变：`requireHttp` 返回值形状、重定向次数上限与自动 `Referer`、POST 遇 301/302/303 降级为 GET、
      跨协议 http→https 跳转、超时值、CA/Agent 逻辑、并发请求头隔离（见第 21 条）、`响应体过大` 文案。
      `Location` 解析不出来仍报 `HTTP Request Failed: Invalid URL`。
    - 后续项（未动，需单独评估）：跨站跳转时不剥离 `Authorization` / `Cookie`、
      `Location: //other-host/x` 的开放重定向、内网地址与元数据端点（`127.0.0.0/8`、
      `169.254.169.254` 等）与 DNS rebinding 的拦截——白名单收的是**协议**这一维。
