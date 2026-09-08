import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError } from '#YukiLib/httpServer/appError';
import { HttpRes } from '#YukiLib/httpServer/httpRes';

import { makeCtx, makeResStub, runIn } from './contextFixture.js';

/**
 * HttpRes：响应侧一行式输出门面
 *
 * 序列化与无体形态语义与既有 RequestJson.responseJson 逐条对照（PHP json_encode 对齐契约）。
 */

/**
 * 在带响应替身的上下文中执行
 *
 * @param {(res: import('./contextFixture.js').ResStub) => void} handler 处理函数
 * @returns {import('./contextFixture.js').ResStub} 响应替身
 */
function writeWith(handler) {
    const res = makeResStub();
    runIn(makeCtx({ res }), () => {
        handler(res);
    });
    return res;
}

describe('HttpRes.jsonRes 统一 JSON 出口', () => {
    it('默认 200：仅 Content-Type，体为 4 空格缩进', () => {
        const res = writeWith(() => HttpRes.jsonRes({ a: 1 }));
        assert.equal(res.statusCode, 200);
        assert.deepEqual(Object.keys(res.headers), ['Content-Type']);
        assert.equal(res.headers['Content-Type'], 'application/json; charset=utf-8');
        assert.equal(res.body, '{\n    "a": 1\n}');
        assert.equal(res.ended, true);
    });

    it('自定义状态码生效', () => {
        const res = writeWith(() => HttpRes.jsonRes({ a: 1 }, 201));
        assert.equal(res.statusCode, 201);
    });

    it('headers 参数：附加头先于 Content-Type 写出，同名时由统一出口覆盖', () => {
        const res = writeWith(() => HttpRes.jsonRes({ a: 1 }, 200, { 'X-Trace-Id': 't-1' }));
        assert.deepEqual(Object.keys(res.headers), ['X-Trace-Id', 'Content-Type']);
        assert.equal(res.headers['X-Trace-Id'], 't-1');

        const override = writeWith(() => HttpRes.jsonRes({}, 200, { 'Content-Type': 'text/plain' }));
        assert.equal(override.headers['Content-Type'], 'application/json; charset=utf-8');
    });

    it('headers 默认 null：与既有行为完全一致（仅 Content-Type）', () => {
        const res = writeWith(() => HttpRes.jsonRes({ a: 1 }));
        assert.deepEqual(Object.keys(res.headers), ['Content-Type']);
    });

    it('JSON_PRETTY_PRINT：4 空格缩进逐层展开，空容器内联', () => {
        const nested = writeWith(() => HttpRes.jsonRes({ a: { b: [1, 'x'] } }));
        assert.equal(
            nested.body,
            '{\n    "a": {\n        "b": [\n            1,\n            "x"\n        ]\n    }\n}',
        );

        const empty = writeWith(() => HttpRes.jsonRes({ list: [], map: {} }));
        assert.equal(empty.body, '{\n    "list": [],\n    "map": {}\n}');
    });

    it('顶层标量不受缩进影响', () => {
        for (const [value, expected] of [[42, '42'], ['文本', '"文本"'], [true, 'true']]) {
            const res = writeWith(() => HttpRes.jsonRes(value));
            assert.equal(res.body, expected);
        }
    });

    it('JSON_UNESCAPED_SLASHES / JSON_UNESCAPED_UNICODE：斜杠与非 ASCII 不转义', () => {
        const res = writeWith(() => HttpRes.jsonRes({ url: 'https://example.test/a/b?c=/d', status: '服务器内部错误', emoji: '🎉' }));
        const body = /** @type {string} */ (res.body);
        assert.ok(body.includes('https://example.test/a/b?c=/d'));
        assert.ok(body.includes('"服务器内部错误"'));
        assert.ok(body.includes('🎉'));
        assert.doesNotMatch(body, /\\\//);
        assert.doesNotMatch(body, /\\u/);
    });

    it('data 显式为 null：不设 Content-Type、不写响应体', () => {
        const res = writeWith(() => HttpRes.jsonRes(null, 307));
        assert.equal(res.statusCode, 307);
        assert.deepEqual(Object.keys(res.headers), []);
        assert.equal(res.body, undefined);
        assert.equal(res.ended, true);
    });

    it('data 省略（undefined）：仍设 Content-Type 且体为空', () => {
        const res = writeWith(() => HttpRes.jsonRes(undefined));
        assert.deepEqual(Object.keys(res.headers), ['Content-Type']);
        assert.equal(res.body, undefined);
    });

    it('假值（0/空串/false）照常序列化', () => {
        for (const [value, expected] of [[0, '0'], ['', '""'], [false, 'false']]) {
            const res = writeWith(() => HttpRes.jsonRes(value));
            assert.equal(res.body, expected);
        }
    });
});

describe('HttpRes.fastResEmpty 无响应体', () => {
    it('默认 200：无头、无体、已结束', () => {
        const res = writeWith(() => HttpRes.fastResEmpty());
        assert.equal(res.statusCode, 200);
        assert.deepEqual(Object.keys(res.headers), []);
        assert.equal(res.body, undefined);
        assert.equal(res.ended, true);
    });

    it('自定义状态码（204）', () => {
        const res = writeWith(() => HttpRes.fastResEmpty(204));
        assert.equal(res.statusCode, 204);
    });

    it('省略状态码时沿用 status() 已设的值', () => {
        const res = writeWith(() => {
            HttpRes.status(204);
            HttpRes.fastResEmpty();
        });
        assert.equal(res.statusCode, 204);
    });
});

describe('HttpRes.fastResRedirect 重定向', () => {
    it('默认 307：仅 Location，无 Content-Type 与响应体', () => {
        const res = writeWith(() => HttpRes.fastResRedirect('/api/v1/target'));
        assert.equal(res.statusCode, 307);
        assert.deepEqual(Object.keys(res.headers), ['Location']);
        assert.equal(res.headers.Location, '/api/v1/target');
        assert.equal(res.body, undefined);
        assert.equal(res.ended, true);
    });

    it('自定义状态码生效（301/302/303/308）', () => {
        for (const code of [301, 302, 303, 308]) {
            const res = writeWith(() => HttpRes.fastResRedirect('https://example.test/a?b=1', code));
            assert.equal(res.statusCode, code);
            assert.equal(res.headers.Location, 'https://example.test/a?b=1');
        }
    });
});

describe('HttpRes.fastResError 快速错误', () => {
    it('默认抛 AppError(400, 参数错误)', () => {
        runIn(makeCtx(), () => {
            assert.throws(
                () => HttpRes.fastResError(),
                (err) => err instanceof AppError && err.statusCode === 400 && err.message === '参数错误',
            );
        });
    });

    it('自定义消息与状态码', () => {
        runIn(makeCtx(), () => {
            assert.throws(
                () => HttpRes.fastResError('密钥错误', 401),
                (err) => err instanceof AppError && err.statusCode === 401 && err.message === '密钥错误',
            );
        });
    });
});

describe('HttpRes 响应修饰', () => {
    it('status 设置状态码，header 设置响应头（先于写出）', () => {
        const res = writeWith(() => {
            HttpRes.status(201);
            HttpRes.header('X-Trace-Id', 't-1');
            HttpRes.jsonRes({ ok: true });
        });
        assert.equal(res.statusCode, 201);
        assert.deepEqual(Object.keys(res.headers), ['X-Trace-Id', 'Content-Type']);
        assert.equal(res.headers['X-Trace-Id'], 't-1');
    });

    it('cookie：默认 HttpOnly + Path=/ + SameSite=Lax，且可多次追加', () => {
        const res = writeWith(() => {
            HttpRes.cookie('sid', 'a b');
            HttpRes.cookie('theme', 'dark', { maxAge: 60, secure: true, httpOnly: false, sameSite: 'Strict' });
        });
        assert.deepEqual(res.cookieLines, [
            'sid=a%20b; Path=/; HttpOnly; SameSite=Lax',
            'theme=dark; Max-Age=60; Path=/; Secure; SameSite=Strict',
        ]);
    });

    it('cookie：非法名抛普通 Error（服务端编程错误，非 AppError）', () => {
        runIn(makeCtx(), () => {
            for (const bad of ['', 'a b', 'a;b', 'a=b', 'a\r\nX: y', 'a[]']) {
                assert.throws(
                    () => HttpRes.cookie(bad, 'v'),
                    (err) => err instanceof Error
                        && !(err instanceof AppError)
                        && err.message.includes('Cookie 名非法'),
                    `非法名应抛普通 Error：${JSON.stringify(bad)}`,
                );
            }
        });

        const res = writeWith(() => {
            HttpRes.cookie('__Host-sid.v1~x', 'v');
        });
        assert.deepEqual(res.cookieLines, ['__Host-sid.v1~x=v; Path=/; HttpOnly; SameSite=Lax']);
    });

    it('请求上下文之外调用：抛明确错误', () => {
        assert.throws(
            () => HttpRes.jsonRes({ a: 1 }),
            (err) => /** @type {Error} */ (err).message.includes('不在 HTTP 请求上下文中'),
        );
    });
});
