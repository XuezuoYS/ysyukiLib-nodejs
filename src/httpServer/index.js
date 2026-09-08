/**
 * 入站 HTTP 服务端子域入口（barrel）
 *
 * 聚合服务端处理三件套，三者共同支撑"宿主应用入口 + 唯一兜底出口"契约：
 * - AppError：业务可预期错误（宿主应用入口兜底出口的契约类型）；
 * - RequestJson：请求体取值与统一 JSON 响应出口；
 * - Router：薄路由（占位符、可选段、反向路由）。
 *
 * 与 `src/httpClient.js`（出站 HTTP）对称：本目录只处理"服务端入站"语义。
 *
 * 以下写法等价（同一实现，类对象同一）：
 * - `import { Router } from 'ysyuki-lib-on-nodejs/httpServer'`
 * - `import { Router } from '#YukiLib/httpServer'`
 * - `import { Router } from 'ysyuki-lib-on-nodejs/httpServer/router'`
 */
export { AppError } from './appError.js';
export { RequestJson } from './requestJson.js';
export { Router } from './router.js';
