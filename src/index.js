/**
 * 包入口（barrel）
 *
 * 对外唯一聚合入口：`import { Config, Logger } from 'ysyuki-lib-on-nodejs'`
 * 等价于逐个从子路径导入（同一实现，类对象同一）。
 *
 * 源码按域组织，本文件是唯一聚合点：
 * - 基础设施：Config（宿主根 / .env / config.json）、Logger（结构化日志）
 * - 出站 HTTP：HttpClient
 * - 入站 HTTP 服务端：httpServer/（HttpServer、Router、HttpReq、HttpRes、ServerLogger、AppError）
 * - 值对象：FuncResult
 */
export { AppError } from './httpServer/appError.js';
export { Config } from './config.js';
export { FuncResult } from './funcResult.js';
export { HttpClient } from './httpClient.js';
export { HttpReq } from './httpServer/httpReq.js';
export { HttpServer } from './httpServer/server.js';
export { HttpRes } from './httpServer/httpRes.js';
export { Logger } from './logger.js';
export { Middleware } from './httpServer/middleware.js';
export { Router } from './httpServer/router.js';
export { ServerLogger } from './httpServer/serverLogger.js';
