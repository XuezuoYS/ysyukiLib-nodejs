import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError } from '#YukiLib/httpServer/appError';
import { HttpReq } from '#YukiLib/httpServer/httpReq';

import { makeCtx, runIn } from './contextFixture.js';

/**
 * HttpReq：请求侧一行式取值门面
 *
 * 请求体（getPostData）语义与既有 RequestJson.getPostDataItem 逐条对照，
 * 确保契约不漂移；query / param / header / cookie / ip 为新增能力。
 */
describe('HttpReq.getPostData 请求体取值', () => {
    it('字段存在且类型匹配：原样返回', () => {
        runIn(makeCtx({ body: { code: 'abc123' } }), () => {
            assert.equal(HttpReq.getPostData('code', 'string'), 'abc123');
        });
    });

    it('字段不存在且未传默认值：抛 AppError(400, 参数错误)', () => {
        runIn(makeCtx({ body: {} }), () => {
            assert.throws(
                () => HttpReq.getPostData('missing', 'string'),
                (err) => err instanceof AppError && err.statusCode === 400 && err.message === '参数错误',
            );
        });
    });

    it('字段值为 null 且未传默认值：同缺失处理', () => {
        runIn(makeCtx({ body: { v: null } }), () => {
            assert.throws(() => HttpReq.getPostData('v', 'string'), AppError);
        });
    });

    it('字段缺失但显式传默认值：返回默认值（含默认值为 null 的情况）', () => {
        runIn(makeCtx({ body: {} }), () => {
            assert.equal(HttpReq.getPostData('v', 'string', 'fallback'), 'fallback');
            assert.equal(HttpReq.getPostData('v', 'none', null), null);
            assert.equal(HttpReq.getPostData('v', 'int', 0), 0);
            assert.equal(HttpReq.getPostData('v', 'bool', false), false);
        });
    });

    it('类型不符：始终抛错，默认值不生效', () => {
        runIn(makeCtx({ body: { v: 42 } }), () => {
            assert.throws(
                () => HttpReq.getPostData('v', 'string', 'ignored'),
                (err) => err instanceof AppError && err.statusCode === 400 && err.message === '类型错误，需要的类型：string',
            );
        });
    });

    it('int：接受整数，拒绝小数/数字字符串/布尔', () => {
        runIn(makeCtx({ body: { a: 5, b: 5.5, c: '5', d: true } }), () => {
            assert.equal(HttpReq.getPostData('a', 'int'), 5);
            for (const key of ['b', 'c', 'd']) {
                assert.throws(
                    () => HttpReq.getPostData(key, 'int'),
                    (err) => /** @type {Error} */ (err).message === '类型错误，需要的类型：int',
                );
            }
        });
    });

    it('float：接受数字，数字字符串强转为 number，拒绝非数字', () => {
        runIn(makeCtx({ body: { a: 5, b: 5.5, c: '12.5', d: '+3e2', e: 'abc', f: true } }), () => {
            assert.equal(HttpReq.getPostData('a', 'float'), 5);
            assert.equal(HttpReq.getPostData('b', 'float'), 5.5);
            assert.equal(HttpReq.getPostData('c', 'float'), 12.5);
            assert.equal(HttpReq.getPostData('d', 'float'), 300);
            assert.throws(() => HttpReq.getPostData('e', 'float'), AppError);
            assert.throws(() => HttpReq.getPostData('f', 'float'), AppError);
        });
    });

    it('bool：仅接受布尔值', () => {
        runIn(makeCtx({ body: { t: true, f: false, s: 'true' } }), () => {
            assert.equal(HttpReq.getPostData('t', 'bool'), true);
            assert.equal(HttpReq.getPostData('f', 'bool'), false);
            assert.throws(() => HttpReq.getPostData('s', 'bool'), AppError);
        });
    });

    it('array：接受 JSON 数组与对象，拒绝标量', () => {
        runIn(makeCtx({ body: { arr: [1, 2], obj: { k: 'v' }, str: 'x' } }), () => {
            assert.deepEqual(HttpReq.getPostData('arr', 'array'), [1, 2]);
            assert.deepEqual(HttpReq.getPostData('obj', 'array'), { k: 'v' });
            assert.throws(() => HttpReq.getPostData('str', 'array'), AppError);
        });
    });

    it('none/缺省：不进行校验', () => {
        runIn(makeCtx({ body: { v: { any: 'thing' }, n: 123 } }), () => {
            assert.deepEqual(HttpReq.getPostData('v'), { any: 'thing' });
            assert.deepEqual(HttpReq.getPostData('v', 'none'), { any: 'thing' });
            assert.equal(HttpReq.getPostData('n'), 123);
        });
    });

    it('空请求体：字段一律按缺失处理', () => {
        runIn(makeCtx({ body: {}, rawBody: '' }), () => {
            assert.equal(HttpReq.getPostData('v', 'none', 'def'), 'def');
            assert.throws(() => HttpReq.getPostData('v', 'none'), AppError);
        });
    });
});

describe('HttpReq.getQuery 查询串取值', () => {
    it('存在即返回，字符串来源允许 int/float/bool 强转', () => {
        runIn(makeCtx({ query: { uid: '42', ratio: '1.5', flag: 'true', off: '0', name: 'x' } }), () => {
            assert.equal(HttpReq.getQuery('uid', 'int'), 42);
            assert.equal(HttpReq.getQuery('ratio', 'float'), 1.5);
            assert.equal(HttpReq.getQuery('flag', 'bool'), true);
            assert.equal(HttpReq.getQuery('off', 'bool'), false);
            assert.equal(HttpReq.getQuery('name', 'string'), 'x');
            assert.equal(HttpReq.getQuery('name'), 'x');
        });
    });

    it('缺失且未传默认值：抛 400 参数错误；传默认值则返回', () => {
        runIn(makeCtx({ query: {} }), () => {
            assert.throws(
                () => HttpReq.getQuery('page', 'int'),
                (err) => err instanceof AppError && err.message === '参数错误',
            );
            assert.equal(HttpReq.getQuery('page', 'int', 1), 1);
        });
    });

    it('类型不符：抛 400 类型错误', () => {
        runIn(makeCtx({ query: { uid: 'abc', arr: 'x' } }), () => {
            assert.throws(
                () => HttpReq.getQuery('uid', 'int'),
                (err) => /** @type {Error} */ (err).message === '类型错误，需要的类型：int',
            );
            assert.throws(() => HttpReq.getQuery('arr', 'array'), AppError);
        });
    });

    it('空值参数（?a=）：string 可返回空串，int 报类型错误', () => {
        runIn(makeCtx({ query: { a: '' } }), () => {
            assert.equal(HttpReq.getQuery('a', 'string'), '');
            assert.throws(() => HttpReq.getQuery('a', 'int'), AppError);
        });
    });
});

describe('HttpReq.getParam 路径参数取值', () => {
    it('存在即返回，支持类型强转与默认值', () => {
        runIn(makeCtx({ params: { uid: '7' } }), () => {
            assert.equal(HttpReq.getParam('uid', 'int'), 7);
            assert.equal(HttpReq.getParam('uid'), '7');
            assert.equal(HttpReq.getParam('missing', 'string', 'none'), 'none');
            assert.throws(() => HttpReq.getParam('missing', 'string'), AppError);
        });
    });

    it('已被路由按类型转换的值：直接校验通过', () => {
        runIn(makeCtx({ params: { uid: 7, flag: true } }), () => {
            assert.equal(HttpReq.getParam('uid', 'int'), 7);
            assert.equal(HttpReq.getParam('uid'), 7);
            assert.equal(HttpReq.getParam('flag', 'bool'), true);
        });
    });
});

describe('HttpReq.getHeader 请求头', () => {
    it('大小写不敏感，缺省返回默认值', () => {
        runIn(makeCtx({ headers: { 'user-agent': 'curl/8' } }), () => {
            assert.equal(HttpReq.getHeader('User-Agent'), 'curl/8');
            assert.equal(HttpReq.getHeader('x-missing'), '');
            assert.equal(HttpReq.getHeader('x-missing', 'def'), 'def');
        });
    });

    it('同名多值以逗号连接', () => {
        runIn(makeCtx({ headers: { 'x-multi': ['a', 'b'] } }), () => {
            assert.equal(HttpReq.getHeader('x-multi'), 'a, b');
        });
    });
});

describe('HttpReq.getCookie', () => {
    it('解析 Cookie 头并解码，缺省返回默认值', () => {
        runIn(makeCtx({ headers: { cookie: 'sid=abc%20d; theme=dark' } }), () => {
            assert.equal(HttpReq.getCookie('sid'), 'abc d');
            assert.equal(HttpReq.getCookie('theme'), 'dark');
            assert.equal(HttpReq.getCookie('missing'), '');
            assert.equal(HttpReq.getCookie('missing', 'def'), 'def');
        });
    });

    it('无 Cookie 头时返回默认值', () => {
        runIn(makeCtx({ headers: {} }), () => {
            assert.equal(HttpReq.getCookie('sid', 'none'), 'none');
        });
    });
});

describe('HttpReq.getIp', () => {
    it('优先取 x-forwarded-for 首项', () => {
        runIn(makeCtx({ headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } }), () => {
            assert.equal(HttpReq.getIp(), '203.0.113.7');
        });
    });

    it('无代理头时取 socket 远端地址', () => {
        const ctx = makeCtx();
        runIn(ctx, () => {
            assert.equal(HttpReq.getIp(), '127.0.0.1');
        });
    });
});

describe('HttpReq 元信息与上下文外行为', () => {
    it('原始体、整体体、方法、路径、requestId', () => {
        runIn(makeCtx({ method: 'PUT', path: '/api/v1/x', body: { a: 1 }, rawBody: '{"a":1}', requestId: 'rid-9' }), () => {
            assert.equal(HttpReq.getRawBody(), '{"a":1}');
            assert.deepEqual(HttpReq.getBody(), { a: 1 });
            assert.equal(HttpReq.getMethod(), 'PUT');
            assert.equal(HttpReq.getPath(), '/api/v1/x');
            assert.equal(HttpReq.getRequestId(), 'rid-9');
            assert.equal(HttpReq.current().requestId, 'rid-9');
        });
    });

    it('请求上下文之外调用：抛明确错误', () => {
        assert.throws(
            () => HttpReq.getPostData('v'),
            (err) => /** @type {Error} */ (err).message.includes('不在 HTTP 请求上下文中'),
        );
    });
});
