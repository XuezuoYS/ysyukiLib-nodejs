# ysyuki-lib-on-nodejs

跨项目通用的 Node.js 基础库：配置、日志、出站 HTTP 客户端与入站 HTTP 服务框架。

零第三方运行时依赖（只用 Node 内置模块）· 纯 JavaScript + JSDoc（无构建链）· ESM ·
目标是"在不同项目里的库体验一致"：同一套类、行为约定与命名风格。

## 特性

- **Config** — 宿主项目根解析，`.env` / `config.json` / `dev.config.json` 读取
- **Logger** — 结构化日志，stdout + 按日滚动文件双通道；记录日志自身永不抛错
- **HttpClient** — 出站 HTTP/HTTPS：重定向（协议白名单）、超时、自定义 CA、响应体上限、并发请求头隔离
- **FuncResult** — 不可变业务结果值对象
- **httpServer** — FastAPI 风格模板路由 + 洋葱中间件 + 一行式请求/响应门面 + 优雅关闭

要求：Node.js `>= 24`（LTS）、`pnpm`、ESM 宿主项目。

## 安装

正式项目按 tag 从 git 仓库安装：

```bash
pnpm add github:XuezuoYS/ysyukiLib-nodejs#v0.1.0

# 等价的另外两种写法
pnpm add git+https://github.com/XuezuoYS/ysyukiLib-nodejs.git#v0.1.0
pnpm add github:XuezuoYS/ysyukiLib-nodejs#semver:^0.1.0
```

本库零运行时依赖、纯 JS 无构建链，装 git 依赖不需要 `prepare` 编译；锁文件记下 tag 对应的
具体 commit，重装复现同一份源码。

同机联调用本地引用（改库立即生效，无需重装）：

```json
{ "dependencies": { "ysyuki-lib-on-nodejs": "link:../ysyukiLib-nodejs" } }
```

若宿主与库同属一个 pnpm workspace，改写成 `"workspace:*"` 即可。两条路径的引用写法完全一致。

## 使用

宿主 `package.json` 加一条 `imports` 映射，即可沿用统一的 `#YukiLib/*` 写法：

```json
{ "imports": { "#YukiLib/*": "ysyuki-lib-on-nodejs/*" } }
```

```js
import { Config } from '#YukiLib/config';
import { Logger } from '#YukiLib/logger';
import { HttpServer, Router, HttpReq, HttpRes, AppError } from '#YukiLib/httpServer';
```

> `#YukiLib/*` 由**宿主自己的** `imports` 提供（该字段是包内私有的，库无法替宿主声明）；
> 不配这条映射就用包名写法 `import { Logger } from 'ysyuki-lib-on-nodejs/logger'`，两者指向同一实现。

### 起一个服务

```js
import { HttpServer, Router, HttpReq, AppError } from '#YukiLib/httpServer';
import { Logger } from '#YukiLib/logger';

const router = new Router({ basePath: '/api' });

// 路径参数按类型转换后作为首参注入；返回值自动序列化为 JSON 200
router.get('/v1/users/{uid:int}', ({ uid }) => ({ uid, type: typeof uid }));

// 一行式取值：缺失/类型不符 → 400 { status: '参数错误' }，显式默认值则不报错
router.post('/v1/login', async () => {
    const username = HttpReq.getPostData('username', 'string');
    const remember = HttpReq.getPostData('remember', 'bool', false);
    if (username === 'bad') throw new AppError('密钥错误', 401);
    return { username, remember };            // 等价于 HttpRes.jsonRes({...})
});

// 中间件洋葱：全局 router.use / 分组 group 内 use / 路由级 options.middleware
router.use(async (ctx, next) => {
    const startedAt = Date.now();
    await next();
    Logger.info('access', { path: ctx.path, ms: Date.now() - startedAt });
});

HttpServer.create({ router, serviceName: 'example-service' })
    .listen(8000, '127.0.0.1', () => Logger.info('服务已启动'));
```

响应与错误契约、执行顺序、模板语法与内置类型、取值类型保证、内置中间件、优雅关闭选项等
完整约定见 **[docs/httpServer.md](./docs/httpServer.md)**。

## 模块

| 子路径 | 导出 |
| --- | --- |
| `ysyuki-lib-on-nodejs/config` | `Config` — 宿主根、`.env` / `config.json` / `dev.config.json` |
| `ysyuki-lib-on-nodejs/logger` | `Logger` / `SubLogger` — 结构化日志；`Logger.create({ level })` 得到等级独立的子 logger |
| `ysyuki-lib-on-nodejs/httpClient` | `HttpClient` — 出站 HTTP/HTTPS 客户端 |
| `ysyuki-lib-on-nodejs/funcResult` | `FuncResult` — 不可变业务结果对象 |
| `ysyuki-lib-on-nodejs/httpServer` | `HttpServer` / `Router` / `HttpReq` / `HttpRes` / `AppError` / `Middleware` / `ServerLogger` / `encodeUrlParam` / `HTTP_METHODS` |
| `ysyuki-lib-on-nodejs/httpServer/<name>` | 子域明细：`server` / `context` / `httpReq` / `httpRes` / `appError` / `serverLogger` / `router` / `onion` / `middleware` |

包根 `ysyuki-lib-on-nodejs` 聚合以上全部 11 个类，等价于逐个从子路径导入。

## 宿主项目可选文件

全部基于**宿主项目根**解析，优先级（首次解析后缓存）：
`Config.setRootDir(dir)` → 环境变量 `YUKI_PROJECT_ROOT` → 入口脚本向上最近的含 `package.json` 的目录 →
`process.cwd()`。`setRootDir(null)` 恢复自动解析并重置缓存；测试里建议显式指定临时根目录。

| 路径 | 必需 | 说明 |
| --- | --- | --- |
| `config.json` | 视项目 | `Config.getConfig(key)` 的取值来源；缺失、解析失败或内容整体不是对象时一律返回 `false` 并记一次 WARN（只带路径与脱敏后的失败类别，不带文件内容） |
| `.env` | 否 | `Config.getEnv(key)` 的补充来源；系统环境变量优先，文件缺失静默忽略；兼容 UTF-8 BOM，不支持 UTF-16 |
| `dev.config.json` | 否 | **存在即开发环境**：日志默认全级别，取值走 `dev[name] > config[name.dev] > config[name]` |
| `CA/cacert.pem` | 否 | 只有私有 / 自签名 CA 才需要（公共站点走 Node 内置根 CA）；`ca` 为**替换**语义，只放需额外信任的私有 CA，想追加用 `NODE_EXTRA_CA_CERTS` |
| `log/` | 否 | 自动创建；`app-YYYY-MM-DD.log`，保留最近 3 天 |

### 日志等级

```js
import { Logger } from '#YukiLib/logger';

Logger.defaultLevel;                            // 宿主根有 dev.config.json → info，否则 warn
const access = Logger.create({ level: 'info' }); // 子 logger 各自独立，不影响根 Logger
access.info('访问明细');                          // 生产环境同样记录
Logger.info('一般信息');                          // 生产默认 warn 阈值 → 丢弃

// HttpServer 实例同理：new ServerLogger({ serviceName, level }) / server.logger.level = 'warn'
```

等级为**阈值**语义（`warn` 记 warn+error，`info` 记全部，`error` 只记 error）。
行格式 `ISO时间\tLEVEL\t消息\t附加字段JSON`；不可序列化的字段降级为 `[Circular]` /
`[BigInt 10]` / `[Getter threw]` 等标记，两个写通道各自独立失败——Logger 常是 `catch` / `onError`
的兜底路径，不能反过来炸宿主。dev 判定按路径缓存，同一路径上增删 `dev.config.json`
需显式 `Logger.resetDevCache()`（或重启）才生效。

## 仓库结构

```
src/             基础设施与出站模块：config / logger / httpClient / funcResult / index
src/httpServer/  入站 HTTP 服务端框架：server / context / httpReq / httpRes / appError /
                 serverLogger / router / onion / middleware（含子域 barrel）
test/            与 src/ 同构镜像；每个模块的实现与测试同仓库同提交
ci/ .github/     CI 夹具与工作流（不进包，files 只含 src）
```

## 开发与发布

```bash
pnpm check    # tsc 静态类型检查（jsconfig.json + JSDoc），exit 0
pnpm test     # node:test 全量
```

这两条就是 CI 门禁逐字执行的命令。测试脚本里 `test/*.test.js` 与 `test/**/*.test.js` 两个模式
**必须都保留**：bash 默认（`globstar off`）下 `**` 等同 `*`，只写后者会静默漏掉 `test/` 顶层的测试文件。

**发新版**：改 `package.json` 的 `version` → 推 `release` 分支。CI 依次做四件事：
三系统（ubuntu / windows / macos）× Node 24 验收（外加一格 ubuntu + Node 26 探 `engines` 上界）；
`pnpm pack` 装进临时宿主校验包边界与 `exports`；**版本门禁**——`version` 严格大于最新 `v*` tag 时
自动打并推送 `v<version>`（相等跳过、低于报错，不允许版本回退）；最后按刚推上去的 tag 真实安装一次并冒烟。
所以一个 tag 的含义就是"三系统验证过、装得上、用得了"。**不要手工打 tag**（不在流水线校验范围内）。

## 文档

- [docs/httpServer.md](./docs/httpServer.md) — httpServer 框架的完整行为约定
- [docs/migrateFrom.md](./docs/migrateFrom.md) — 旧 API 迁移对照，以及历次行为/安全差异（含破坏性变更清单）

## 许可证

[MIT](./LICENSE)
