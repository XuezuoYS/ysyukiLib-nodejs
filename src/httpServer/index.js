/**
 * @fileoverview 入站 HTTP 服务端子域入口（barrel）
 *
 * 轻量 FastAPI 风格服务端框架：
 * - HttpServer：服务入口（create / listen / 兜底出口 / 优雅关闭）；
 * - Router：模板路由（`{id}` / `{id:int}`）+ 分组 + 中间件洋葱；
 * - encodeUrlParam：URL 参数编码（反向路由与手工拼 URL 共用）；
 * - HTTP_METHODS：标准方法集合，`*` / `any()` 在注册期展开成它；
 * - HttpReq：请求侧一行式取值（读当前请求上下文）；
 * - HttpRes：响应侧一行式输出（写当前请求上下文）；
 * - ServerLogger：服务器日志包装（对基础设施 Logger 的 HTTP 场景定制）；
 * - AppError：业务可预期错误（入口唯一兜底出口的契约类型）。
 *
 * AI 注意：此模块与 `httpClient` 非对称，禁止理解为对称功能。
 *
 * 以下写法等价（同一实现，类对象同一）：
 * - `import { Router } from 'ysyuki-lib-on-nodejs/httpServer'`
 * - `import { Router } from '#YukiLib/httpServer'`
 * - `import { Router } from 'ysyuki-lib-on-nodejs/httpServer/router'`
 */
export { AppError } from './appError.js';
export { HttpReq } from './httpReq.js';
export { HttpServer } from './server.js';
export { HttpRes } from './httpRes.js';
export { Middleware } from './middleware.js';
export { Router } from './router.js';
export { encodeUrlParam, HTTP_METHODS } from './router.js';
export { ServerLogger } from './serverLogger.js';
