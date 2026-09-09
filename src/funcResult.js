/**
 * 统一业务结果对象
 *
 * 用于功能层向控制器返回业务执行结果，
 * 替代数组 [状态码, 信息] 或 bool|string 等多情况返回。
 *
 * 不可变值对象：创建后 Object.freeze 冻结，
 * 每个函数每次执行都会新建一个独立实例，实例之间互不干扰。
 *
 * 常用函数：
 * - FuncResult.ok(data, code, message)：成功结果
 * - FuncResult.fail(message, code)：失败结果
 * - isSuccess()：是否成功
 * - getMessage()：提示信息
 * - getData()：业务数据
 * - getCode()：状态码，默认为 0，具体由函数注释约定，注释没有直接忽略
 *
 */
export class FuncResult {
    /**
     * @default message = '', data = null, code = 0
     * @param {boolean} success 是否成功
     * @param {string} [message] 提示信息
     * @param {any} [data] 业务数据
     * @param {number} [code] 状态码
     */
    constructor(success, message = '', data = null, code = 0) {
        this.success = success;
        this.message = message;
        this.data = data;
        this.code = code;
        Object.freeze(this);
    }

    /**
     * 构造成功结果
     *
     * @default data = null, code = 0, message = '成功'
     * @param {any} [data] 业务数据
     * @param {number} [code] 状态码
     * @param {string} [message] 提示信息
     * @returns {FuncResult} 成功结果
     */
    static ok(data = null, code = 0, message = '成功') {
        return new FuncResult(true, message, data, code);
    }

    /**
     * 构造失败结果
     *
     * @default code = 0
     * @param {string} message 提示信息
     * @param {number} [code] 状态码
     * @returns {FuncResult} 失败结果
     */
    static fail(message, code = 0) {
        return new FuncResult(false, message, null, code);
    }

    /**
     * 是否成功
     * @returns {boolean}
     */
    isSuccess() {
        return this.success;
    }

    /**
     * 提示信息，错误信息用这个查询
     * @returns {string}
     */
    getMessage() {
        return this.message;
    }

    /**
     * 业务数据，成功后可查询这个，默认 null
     * @returns {any}
     */
    getData() {
        return this.data;
    }

    /**
     * 状态码，默认 0，用于一些判断情况，具体实现参考函数注释约定
     * @returns {number}
     */
    getCode() {
        return this.code;
    }
}
