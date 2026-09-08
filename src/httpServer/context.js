import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 入站 HTTP 请求上下文（AsyncLocalStorage 承载）
 *
 * 一行式门面 HttpReq / JsonRes 经本模块读取"当前请求"，
 * 因此 handler 内不必层层传递 ctx；并发请求各自独立，互不串数据。
 *
 * 生命周期：由 HttpServer 在请求入口 `runWithContext(ctx, handler)` 建立，
 * 请求结束自动失效。在请求上下文之外调用门面会抛出明确错误，
 * 不会静默返回脏数据（如定时任务里误用 HttpReq.getPostData 会立即失败）。
 *
 * 禁忌：在 `runWithContext` 之外创建、并在请求结束后才触发的定时器/回调
 * （如先 `setTimeout` 再 `await`）不属于任何请求上下文。
 *
 * @typedef {object} HttpContext
 * @property {import('node:http').IncomingMessage} req 原始请求对象
 * @property {import('node:http').ServerResponse} res 原始响应对象
 * @property {string} method HTTP 方法（大写）
 * @property {string} path 归一化后的请求路径
 * @property {Record<string, string|number|boolean>} params 路径参数（按模板类型转换）
 * @property {URLSearchParams} query 查询参数
 * @property {Record<string, any>} body 请求体（已解析；空体/无体为空对象）
 * @property {string} rawBody 请求体原始文本
 * @property {string} requestId 请求标识（日志与排障关联用）
 * @property {Record<string, any>} state 中间件共享状态（约定键名，避免互踩）
 * @property {import('./serverLogger.js').ServerLoggerRequestLog} logger 请求级日志
 * @property {Record<string, string>} [cookies] Cookie 惰性解析缓存（内部使用）
 */

/**
 * 当前请求上下文存储
 * @type {AsyncLocalStorage<HttpContext>}
 */
const storage = new AsyncLocalStorage();

/**
 * 在指定请求上下文中执行处理链（框架内部使用）
 *
 * @template T
 * @param {HttpContext} ctx 请求上下文
 * @param {() => T} handler 处理函数（可返回 Promise）
 * @returns {T} handler 的返回值
 */
export function runWithContext(ctx, handler) {
    return storage.run(ctx, handler);
}

/**
 * 读取当前请求上下文
 *
 * @returns {HttpContext} 当前请求上下文
 * @throws {Error} 不在请求上下文中时抛出（避免静默返回脏数据）
 */
export function getCurrentContext() {
    const ctx = storage.getStore();
    if (ctx === undefined) {
        throw new Error('当前不在 HTTP 请求上下文中：HttpReq / JsonRes 只能在请求处理链内使用');
    }
    return ctx;
}

/**
 * 读取当前请求上下文（不存在时返回 null，供可选场景判定）
 *
 * @returns {HttpContext|null} 当前请求上下文或 null
 */
export function tryGetCurrentContext() {
    return storage.getStore() ?? null;
}
