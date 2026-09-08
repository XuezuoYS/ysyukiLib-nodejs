import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError } from '#YukiLib/httpServer/appError';
import { RequestJson } from '#YukiLib/httpServer/requestJson';

/**
 * 构造指定请求体文本的 RequestJson 实例
 * @param {string|null} rawBody 请求体
 * @returns {RequestJson} 实例
 */
function makeInstance(rawBody) {
    return new RequestJson(rawBody);
}

describe('RequestJson 构造与解析', () => {
    it('POST：合法 JSON 对象解析为数据', () => {
        const instance = makeInstance('{"a":"x","b":1}');
        assert.deepEqual(instance.inputData, { a: 'x', b: 1 });
    });

    it('非 POST（rawBody=null）：数据为空对象', () => {
        const instance = makeInstance(null);
        assert.deepEqual(instance.inputData, {});
    });

    it('空/非法 JSON：回退为空对象', () => {
        assert.deepEqual(makeInstance('').inputData, {});
        assert.deepEqual(makeInstance('not json').inputData, {});
        assert.deepEqual(makeInstance('42').inputData, {});
        assert.deepEqual(makeInstance('null').inputData, {});
    });

    it('JSON 数组请求体：原样保留', () => {
        const instance = makeInstance('[1,2,3]');
        assert.deepEqual(instance.inputData, [1, 2, 3]);
    });
});

describe('RequestJson.getPostDataItem', () => {
    it('字段存在且类型匹配：原样返回', () => {
        const instance = makeInstance('{"code":"abc123"}');
        assert.equal(instance.getPostDataItem('code', 'string'), 'abc123');
    });

    it('字段不存在且未传默认值：抛 AppError(400, 参数错误)', () => {
        const instance = makeInstance('{}');
        assert.throws(
            () => instance.getPostDataItem('missing', 'string'),
            (err) => err instanceof AppError && err.statusCode === 400 && err.message === '参数错误',
        );
    });

    it('字段值为 null 且未传默认值：同缺失处理', () => {
        const instance = makeInstance('{"v":null}');
        assert.throws(() => instance.getPostDataItem('v', 'string'), AppError);
    });

    it('字段缺失但显式传默认值：返回默认值（含默认值为 null 的情况）', () => {
        const instance = makeInstance('{}');
        assert.equal(instance.getPostDataItem('v', 'string', 'fallback'), 'fallback');
        assert.equal(instance.getPostDataItem('v', 'none', null), null);
        assert.equal(instance.getPostDataItem('v', 'int', 0), 0);
        assert.equal(instance.getPostDataItem('v', 'bool', false), false);
    });

    it('类型不符：始终抛错，默认值不生效', () => {
        const instance = makeInstance('{"v":42}');
        assert.throws(
            () => instance.getPostDataItem('v', 'string', 'ignored'),
            (err) => err instanceof AppError && err.statusCode === 400 && err.message === '类型错误，需要的类型：string',
        );
    });

    it('int：接受整数，拒绝小数/数字字符串/布尔', () => {
        const instance = makeInstance('{"a":5,"b":5.5,"c":"5","d":true}');
        assert.equal(instance.getPostDataItem('a', 'int'), 5);
        for (const key of ['b', 'c', 'd']) {
            assert.throws(
                () => instance.getPostDataItem(key, 'int'),
                (err) => /** @type {Error} */ (err).message === '类型错误，需要的类型：int',
            );
        }
    });

    it('float：接受数字，数字字符串强转为 number，拒绝非数字', () => {
        const jsonInstance = makeInstance('{"a":5,"b":5.5,"c":"12.5","d":"+3e2","e":"abc","f":true}');
        assert.equal(jsonInstance.getPostDataItem('a', 'float'), 5);
        assert.equal(jsonInstance.getPostDataItem('b', 'float'), 5.5);
        assert.equal(jsonInstance.getPostDataItem('c', 'float'), 12.5);
        assert.equal(jsonInstance.getPostDataItem('d', 'float'), 300);
        assert.throws(() => jsonInstance.getPostDataItem('e', 'float'), AppError);
        assert.throws(() => jsonInstance.getPostDataItem('f', 'float'), AppError);
    });

    it('bool：仅接受布尔值', () => {
        const instance = makeInstance('{"t":true,"f":false,"s":"true"}');
        assert.equal(instance.getPostDataItem('t', 'bool'), true);
        assert.equal(instance.getPostDataItem('f', 'bool'), false);
        assert.throws(() => instance.getPostDataItem('s', 'bool'), AppError);
    });

    it('array：接受 JSON 数组与对象，拒绝标量', () => {
        const instance = makeInstance('{"arr":[1,2],"obj":{"k":"v"},"str":"x"}');
        assert.deepEqual(instance.getPostDataItem('arr', 'array'), [1, 2]);
        assert.deepEqual(instance.getPostDataItem('obj', 'array'), { k: 'v' });
        assert.throws(() => instance.getPostDataItem('str', 'array'), AppError);
    });

    it('none/默认：不进行验证', () => {
        const instance = makeInstance('{"v":{"any":"thing"}}');
        assert.deepEqual(instance.getPostDataItem('v'), { any: 'thing' });
        assert.deepEqual(instance.getPostDataItem('v', 'none'), { any: 'thing' });
    });

    it('type 缺省为 none：字段存在即返回，不做校验', () => {
        const instance = makeInstance('{"v":123}');
        assert.equal(instance.getPostDataItem('v'), 123);
    });
});

/**
 * 最小响应替身：统一出口只用到 statusCode / setHeader / end 三个成员
 *
 * @typedef {object} ResStub
 * @property {number} statusCode 已设置的状态码
 * @property {Record<string, string>} headers 按写出顺序记录的响应头
 * @property {boolean} ended 是否已结束响应
 * @property {string|undefined} body 传入 end() 的响应体
 */

/**
 * 构造响应替身
 *
 * @returns {ResStub} 替身
 */
function makeResStub() {
    const stub = {
        statusCode: 0,
        /** @type {Record<string, string>} */
        headers: {},
        ended: false,
        /** @type {string|undefined} */
        body: undefined,
        /**
         * @param {string} name 头名
         * @param {string} value 头值
         */
        setHeader(name, value) {
            this.headers[name] = value;
        },
        /**
         * @param {string} [chunk] 响应体
         */
        end(chunk) {
            this.ended = true;
            this.body = chunk;
        },
    };
    return /** @type {ResStub} */ (/** @type {unknown} */ (stub));
}

/**
 * @param {ResStub} stub 响应替身
 * @returns {import('node:http').ServerResponse} 供统一出口消费的形态
 */
function asResponse(stub) {
    return /** @type {import('node:http').ServerResponse} */ (/** @type {unknown} */ (stub));
}

describe('RequestJson.responseJson 附加响应头', () => {
    it('不传附加头时与既有行为完全一致（仅 Content-Type）', () => {
        const stub = makeResStub();
        RequestJson.responseJson(asResponse(stub), { a: 1 }, 201);
        assert.equal(stub.statusCode, 201);
        assert.deepEqual(Object.keys(stub.headers), ['Content-Type']);
        assert.equal(stub.body, '{\n    "a": 1\n}');
        assert.equal(stub.ended, true);
    });

    it('附加头先于 Content-Type 写出', () => {
        const stub = makeResStub();
        RequestJson.responseJson(asResponse(stub), {}, 307, { Location: '/x' });
        assert.deepEqual(Object.keys(stub.headers), ['Location', 'Content-Type']);
        assert.equal(stub.headers.Location, '/x');
        assert.equal(stub.body, '{}');
    });

    it('附加头与 Content-Type 同名时由统一出口覆盖', () => {
        const stub = makeResStub();
        RequestJson.responseJson(asResponse(stub), {}, 200, { 'Content-Type': 'text/plain' });
        assert.equal(stub.headers['Content-Type'], 'application/json; charset=utf-8');
    });

    it('data 显式为 null：不设 Content-Type、不写响应体', () => {
        const stub = makeResStub();
        RequestJson.responseJson(asResponse(stub), null, 307, { Location: '/x' });
        assert.equal(stub.statusCode, 307);
        assert.deepEqual(Object.keys(stub.headers), ['Location']);
        assert.equal(stub.body, undefined);
        assert.equal(stub.ended, true);
    });

    it('data 为 null 且无附加头：只改状态码就结束（空 200 形态）', () => {
        const stub = makeResStub();
        RequestJson.responseJson(asResponse(stub), null);
        assert.equal(stub.statusCode, 200);
        assert.deepEqual(Object.keys(stub.headers), []);
        assert.equal(stub.body, undefined);
        assert.equal(stub.ended, true);
    });

    it('data 省略（undefined）与显式 null 语义不同：仍设 Content-Type', () => {
        const stub = makeResStub();
        RequestJson.responseJson(asResponse(stub), undefined);
        assert.deepEqual(Object.keys(stub.headers), ['Content-Type']);
    });

    it('data 为 JSON null 值以外的假值（0/空串/false）照常序列化', () => {
        for (const [value, expected] of [[0, '0'], ['', '""'], [false, 'false']]) {
            const stub = makeResStub();
            RequestJson.responseJson(asResponse(stub), value);
            assert.equal(stub.body, expected);
        }
    });
});

describe('RequestJson.responseJson 体序列化格式（PHP json_encode 对齐契约）', () => {
    /**
     * 经统一出口写出并返回响应体文本
     *
     * @param {any} data 响应数据
     * @returns {string|undefined} 响应体文本
     */
    function encodeViaExit(data) {
        const stub = makeResStub();
        RequestJson.responseJson(asResponse(stub), data);
        return stub.body;
    }

    it('JSON_PRETTY_PRINT：4 空格缩进逐层展开，冒号后带单空格', () => {
        assert.equal(
            encodeViaExit({ a: { b: [1, 'x'] } }),
            '{\n    "a": {\n        "b": [\n            1,\n            "x"\n        ]\n    }\n}',
        );
    });

    it('JSON_PRETTY_PRINT：空数组/空对象内联，不产生换行', () => {
        assert.equal(encodeViaExit({}), '{}');
        assert.equal(
            encodeViaExit({ list: [], map: {} }),
            '{\n    "list": [],\n    "map": {}\n}',
        );
    });

    it('JSON_PRETTY_PRINT：顶层标量不受缩进影响', () => {
        // 注意：data 显式为 null 是统一出口的"无体"契约，不进入序列化，故不在此列
        assert.equal(encodeViaExit(42), '42');
        assert.equal(encodeViaExit('文本'), '"文本"');
        assert.equal(encodeViaExit(true), 'true');
    });

    it('JSON_UNESCAPED_SLASHES：URL 中的斜杠不转义为 \\/', () => {
        const body = /** @type {string} */ (encodeViaExit({ url: 'https://example.test/a/b?c=/d' }));
        assert.ok(body.includes('https://example.test/a/b?c=/d'));
        assert.doesNotMatch(body, /\\\//);
    });

    it('JSON_UNESCAPED_UNICODE：中文等非 ASCII 原样输出，不转义为 \\uXXXX', () => {
        const body = /** @type {string} */ (encodeViaExit({ status: '服务器内部错误', emoji: '🎉' }));
        assert.ok(body.includes('"服务器内部错误"'));
        assert.ok(body.includes('🎉'));
        assert.doesNotMatch(body, /\\u/);
    });
});

describe('RequestJson.responseFastJump', () => {
    it('默认 307：经统一出口写出 Location，无 Content-Type 与响应体', () => {
        const stub = makeResStub();
        RequestJson.responseFastJump(asResponse(stub), '/api/v1/target');
        assert.equal(stub.statusCode, 307);
        assert.deepEqual(Object.keys(stub.headers), ['Location']);
        assert.equal(stub.headers.Location, '/api/v1/target');
        assert.equal(stub.body, undefined);
        assert.equal(stub.ended, true);
    });

    it('自定义状态码生效（301/302/303/308）', () => {
        for (const code of [301, 302, 303, 308]) {
            const stub = makeResStub();
            RequestJson.responseFastJump(asResponse(stub), 'https://example.test/a?b=1', code);
            assert.equal(stub.statusCode, code);
            assert.equal(stub.headers.Location, 'https://example.test/a?b=1');
        }
    });

    // 头值合法性（CR/LF 注入）由 Node 的 setHeader 承担，替身不会校验。
});

describe('RequestJson.responseFastError', () => {
    it('默认输出 400 参数错误的 AppError', () => {
        assert.throws(
            () => RequestJson.responseFastError(),
            (err) => err instanceof AppError && err.statusCode === 400 && err.message === '参数错误',
        );
    });

    it('自定义消息与状态码', () => {
        assert.throws(
            () => RequestJson.responseFastError('密钥错误', 400),
            (err) => /** @type {import('#YukiLib/httpServer/appError').AppError} */ (err).statusCode === 400 && /** @type {Error} */ (err).message === '密钥错误',
        );
    });
});
