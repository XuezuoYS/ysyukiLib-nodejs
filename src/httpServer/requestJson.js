import { AppError } from './appError.js';

/**
 * 数字字符串判定（十进制子集；十六进制字符串不算数字）
 *
 * @param {string} value 待判定字符串
 * @returns {boolean} 是否为数字字符串
 */
function isNumericString(value) {
    return /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(value);
}

/**
 * JSON 数据处理类
 *
 * 用于规范化网络请求与响应的 JSON 数据，
 * 提供统一的 JSON 响应输出与请求体数据项获取。
 *
 * 缓存语义：以"每请求一个实例 + 实例内惰性缓存"实现请求级解析缓存；
 * 实例由应用入口解析请求体后构造，方法读取本请求数据，无跨请求污染风险。
 * 响应输出仍为静态方法。
 *
 * 常用函数：
 * - RequestJson.responseJson(res, data, httpCode, extraHeaders):统一响应出口，全项目所有响应都经此写出；
 *   data 传 null 为"无响应体"形态（不设 Content-Type，用于重定向与空 200）；
 * - RequestJson.responseFastJump(res, url, httpCode):3xx 重定向（默认 307，仅 Location 头无响应体；不终止控制流）；
 * - RequestJson.responseFastError(message, httpCode):快速错误响应（throw AppError，由应用入口唯一兜底出口输出）；
 * - getPostDataItem(name, type, default):获取请求体数据项；显式传入第三个参数后，字段缺失时返回默认值；类型不符仍报错
 *
 */
export class RequestJson {
    /**
     * 请求体数据（实例快照）
     *
     * 构造时从请求体原始文本解析得到，可直接读取原始数据
     * @type {Record<string, any>}
     */
    inputData = {};

    /**
     * 解析请求体并填充实例数据
     *
     * @param {string|null} [rawBody] 请求体原始文本（仅 POST 由应用入口传入；非 POST 传 null，数据为空对象）
     * @default rawBody = null
     */
    constructor(rawBody = null) {
        if (rawBody === null) {
            this.inputData = {};
            return;
        }

        /** @type {any} */
        let decoded = null;
        try {
            decoded = JSON.parse(rawBody);
        } catch {
            decoded = null;
        }

        // 解析失败（空/非法 JSON/标量）时回退为空对象
        this.inputData = decoded !== null && typeof decoded === 'object' ? decoded : {};
    }

    /**
     * 获取 POST 数据项
     *
     * 字段不存在（或值为 null）时：
     * - 显式传入了第三个参数 default：返回默认值，不进入错误流程
     * - 未传入 default：抛 AppError(400, '参数错误')，由应用入口唯一兜底出口输出
     * 字段存在但类型不符时：始终抛错（default 不生效）
     *
     * @param {string} name 数据项名称
     * @param {string} [type] 数据项类型，none 则不进行验证
     * - string: 字符串
     * - int: 整数
     * - bool: 布尔值
     * - array: 数组（JSON 对象一并接受）
     * - float: 浮点数（允许数字字符串并强转）
     * - none: 不进行验证
     * @default type = 'none'
     * @param {...any} rest 默认值（仅当显式传入时生效，用参数个数判断，以支持默认值本身为 null 的情况）
     * @returns {any} 数据项值，或默认值
     */
    getPostDataItem(name, type = 'none', ...rest) {
        // 是否显式传入了默认值
        const hasDefault = rest.length >= 1;

        // 字段不存在（或值为 null）时，有默认值则返回默认值，否则走错误流程
        if (!Object.prototype.hasOwnProperty.call(this.inputData, name) || this.inputData[name] === null) {
            if (hasDefault) {
                return rest[0];
            }
            RequestJson.responseFastError();
        }

        let data = this.inputData[name];
        switch (type) {
            case 'string':
                if (typeof data !== 'string') {
                    RequestJson.responseFastError(`类型错误，需要的类型：${type}`);
                }
                break;
            case 'int':
                if (!Number.isInteger(data)) {
                    RequestJson.responseFastError(`类型错误，需要的类型：${type}`);
                }
                break;
            case 'bool':
                if (typeof data !== 'boolean') {
                    RequestJson.responseFastError(`类型错误，需要的类型：${type}`);
                }
                break;
            case 'array':
                // 对象/数组同属"结构"语义，一并接受
                if (!(Array.isArray(data) || (typeof data === 'object' && data !== null))) {
                    RequestJson.responseFastError(`类型错误，需要的类型：${type}`);
                }
                break;
            case 'float':
                if (typeof data === 'number') {
                    break;
                }
                if (typeof data === 'string' && isNumericString(data)) {
                    // 字符串形式的数字，转换为浮点数
                    data = Number(data);
                    break;
                }
                RequestJson.responseFastError(`类型错误，需要的类型：${type}`);
                break;
            default:
                break;
        }
        return data;
    }

    /**
     * 返回 JSON 数据（统一出口）
     *
     * 全项目所有响应都经本函数写出。体输出等价 PHP
     * `json_encode($data, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE)`（契约）
     *
     * data 显式为 `null` 时：只写状态码与附加头，**不设 Content-Type、不写响应体**
     * （3xx 重定向、空 200 等无体响应即用此形态）。
     * 注意与"省略 data 参数"（值为 undefined）区分：后者仍设 Content-Type 且写出空体。
     *
     * @param {import('node:http').ServerResponse} res 响应对象
     * @param {any} data 响应数据；显式传 null 表示无响应体且不声明 Content-Type: application/json
     * @param {number} [httpCode] HTTP 状态码
     * @default httpCode = 200
     * @param {Record<string, string>|null} [extraHeaders] 附加响应头（如重定向的 Location）；
     * 先于 Content-Type 设置，同名时由本函数覆盖（data 为 null 时不涉及 Content-Type）
     * @default extraHeaders = null
     */
    static responseJson(res, data, httpCode = 200, extraHeaders = null) {
        res.statusCode = httpCode;
        if (extraHeaders !== null) {
            for (const [name, value] of Object.entries(extraHeaders)) {
                res.setHeader(name, value);
            }
        }

        if (data === null) {
            // 无体形态：不声明 Content-Type: application/json，也不写出任何字节
            res.end();
            return;
        }

        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        // 4 空格缩进即 JSON_PRETTY_PRINT；斜杠与非 ASCII 不转义是 stringify 默认（两 UNESCAPED 标志）
        res.end(JSON.stringify(data, null, 4));
    }

    /**
     * 快速返回重定向响应（responseJson 的再封装）
     *
     * 经统一出口以"无响应体"形态写出：只有 `httpCode` 与 `Location` 头
     * （不设 Content-Type，data 传 null）。
     *
     * 307 的语义：客户端必须以相同的请求方法与请求体重放到目标地址；
     * 若希望浏览器改用 GET 重放，显式传 303（302 在各实现中对 POST 的处理不一致，不推荐）。
     *
     * 与 responseFastError 不同：本函数不抛异常、**不终止控制流**，
     * 调用之后必须自行 `return`，否则处理器余下的业务代码仍会照常执行。
     *
     * @param {import('node:http').ServerResponse} res 响应对象
     * @param {string} url 重定向目标。站内跳转用相对路径（如 `/api/v1/x`）；
     * 传完整 URL 时不得回填内部监听地址（服务只监听 127.0.0.1，须由调用方给出对外地址）
     * @param {number} [httpCode] HTTP 3xx 状态码
     * @default httpCode = 307
     */
    static responseFastJump(res, url, httpCode = 307) {
        // url 含 CR/LF 等非法头字符时由 setHeader 抛出 ERR_INVALID_CHAR，
        // 落应用入口唯一兜底出口转 500，不会写出被污染的响应头（响应头注入防护）
        RequestJson.responseJson(res, null, httpCode, { Location: url });
    }

    /**
     * 快速返回错误信息
     *
     * 输出 `{"status": message}`：throw AppError，
     * 由应用入口 handleRequest 的唯一兜底出口输出响应体。
     *
     * @param {string} [message] 错误信息
     * @default message = '参数错误'
     * @param {number} [httpCode] HTTP 状态码
     * @default httpCode = 400
     */
    static responseFastError(message = '参数错误', httpCode = 400) {
        throw new AppError(message, httpCode);
    }
}
