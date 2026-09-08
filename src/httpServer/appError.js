/**
 * 业务可预期错误：业务侧 throw，由 HttpServer 的唯一兜底出口统一输出
 *
 * 该出口捕获 AppError 后输出 `{ "status": message }` 响应体，状态码取 `statusCode`
 * （默认 400）；这是本库对外的错误响应契约，`data` 仅内部使用、不进入响应体。
 *
 * 常用函数：
 * - new AppError(message, statusCode, data):业务可预期错误
 *
 */
export class AppError extends Error {
    /**
     * HTTP 状态码
     * @type {number}
     */
    statusCode;

    /**
     * 可选附加数据（默认不输出到响应体，仅日志/内部使用）
     * @type {any}
     */
    data;

    /**
     * @param {string} [message] 错误信息（响应体 status 字段内容）
     * @default message = '参数错误'
     * @param {number} [statusCode] HTTP 状态码
     * @default statusCode = 400
     * @param {any} [data] 可选附加数据
     * @default data = undefined
     */
    constructor(message = '参数错误', statusCode = 400, data = undefined) {
        super(message);
        this.name = 'AppError';
        this.statusCode = statusCode;
        this.data = data;
    }
}
