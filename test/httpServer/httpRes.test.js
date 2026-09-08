import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError } from '#YukiLib/httpServer/appError';
import { HttpRes } from '#YukiLib/httpServer/httpRes';

import { makeCtx, makeResStub, runIn } from './contextFixture.js';

/**
 * HttpRes：响应侧一行式输出门面
 *
 * 序列化与无体形态逐条对照对外契约（对齐 PHP `json_encode` 的
 * `JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE`）。
 */

/**
 * 在带响应替身的上下文中执行
 *
 * @param {(res: import('./contextFixture.js').ResStub) => void} handler 处理函数
 * @param {Parameters<typeof makeCtx>[0]} [ctxOptions] 上下文选项覆盖（如 method: 'HEAD'）
 * @returns {import('./contextFixture.js').ResStub} 响应替身
 */
function writeWith(handler, ctxOptions = {}) {
    const res = makeResStub();
    runIn(makeCtx({ res, ...ctxOptions }), () => {
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

    it('headers 默认 null：只写 Content-Type', () => {
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

    it('HEAD + data 省略（undefined）：不抛错，Content-Length 落 0', () => {
        // stringify(undefined) 返回 undefined（不是字符串），此处不得因取字节数而炸
        const res = writeWith(() => HttpRes.jsonRes(undefined), { method: 'HEAD' });
        assert.deepEqual(Object.keys(res.headers), ['Content-Type', 'Content-Length']);
        assert.equal(res.headers['Content-Length'], '0');
        assert.equal(res.body, undefined);
        assert.equal(res.ended, true);
    });

    it('HEAD + data 为函数（stringify 结果为 undefined）：同上', () => {
        const res = writeWith(() => HttpRes.jsonRes(() => 1), { method: 'HEAD' });
        assert.equal(res.headers['Content-Length'], '0');
        assert.equal(res.ended, true);
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

    it('cookie：合法属性全部规范化输出', () => {
        const res = writeWith(() => {
            HttpRes.cookie('sid', 'v', {
                domain: '.example.com',
                path: '/app',
                maxAge: 60.7,
                expires: '2030-01-01T00:00:00Z',
                sameSite: 'none',
            });
        });
        assert.deepEqual(res.cookieLines, [
            'sid=v; Max-Age=60; Expires=Tue, 01 Jan 2030 00:00:00 GMT; Domain=.example.com; Path=/app; HttpOnly; SameSite=None',
        ]);
    });

    it('cookie：空值一律视为未设置（兼容 Config.getConfig 取不到返回 false）', () => {
        const res = writeWith(() => {
            HttpRes.cookie('sid', 'v', { domain: false, path: '', maxAge: null, expires: undefined, sameSite: '' });
        });
        assert.deepEqual(res.cookieLines, ['sid=v; Path=/; HttpOnly; SameSite=Lax']);
    });

    it('cookie：单标签域名与 IP 字面量按主机名规则放行', () => {
        const res = writeWith(() => {
            HttpRes.cookie('a', '1', { domain: 'localhost' });
            HttpRes.cookie('b', '2', { domain: '127.0.0.1' });
        });
        assert.deepEqual(res.cookieLines, [
            'a=1; Domain=localhost; Path=/; HttpOnly; SameSite=Lax',
            'b=2; Domain=127.0.0.1; Path=/; HttpOnly; SameSite=Lax',
        ]);
    });

    it('cookie：非法属性值抛普通 Error（服务端配置错误，非 AppError）', () => {
        const cases = [
            ['domain', 'bad domain'],
            ['domain', 'exa_mple.com'],
            ['domain', '-bad.com'],
            ['domain', `${'a'.repeat(64)}.com`],
            ['domain', 'example.com.'],
            ['domain', '中文.com'],
            ['path', 'app'],
            ['path', '/a;b'],
            ['path', '/资料'],
            ['maxAge', 'soon'],
            ['maxAge', Infinity],
            ['expires', 'not-a-date'],
            ['sameSite', 'Sometimes'],
        ];
        for (const [key, value] of cases) {
            runIn(makeCtx(), () => {
                assert.throws(
                    () => HttpRes.cookie('sid', 'v', { [key]: value }),
                    (err) => err instanceof Error
                        && !(err instanceof AppError)
                        && err.message.includes('非法'),
                    `${key}=${String(value)} 应抛错`,
                );
            });
        }
    });

    it('请求上下文之外调用：抛明确错误', () => {
        assert.throws(
            () => HttpRes.jsonRes({ a: 1 }),
            (err) => /** @type {Error} */ (err).message.includes('不在 HTTP 请求上下文中'),
        );
    });
});

describe('HttpRes 状态码日志（唯一出口）', () => {
    /**
     * 记录 response() 调用的请求级日志替身
     *
     * @returns {{calls: number[], logger: any}} 调用记录与日志替身
     */
    function spyLogger() {
        /** @type {number[]} */
        const calls = [];
        return {
            calls,
            logger: {
                info() {},
                warn() {},
                error() {},
                access() {},
                /**
                 * @param {number} statusCode 响应状态码
                 */
                response(statusCode) {
                    calls.push(statusCode);
                },
            },
        };
    }

    it('jsonRes 显式状态码：写出后按最终状态码记一次', () => {
        const { calls, logger } = spyLogger();
        writeWith(() => HttpRes.jsonRes({ a: 1 }, 404), { logger });
        assert.deepEqual(calls, [404]);
    });

    it('省略状态码：沿用 status() 已设的值，不打回 200', () => {
        const { calls, logger } = spyLogger();
        writeWith(() => {
            HttpRes.status(201);
            HttpRes.jsonRes({ a: 1 });
        }, { logger });
        assert.deepEqual(calls, [201]);
    });

    it('无体 / 重定向 / 空响应形态各记一次', () => {
        const { calls, logger } = spyLogger();
        writeWith(() => HttpRes.fastResEmpty(204), { logger });
        writeWith(() => HttpRes.fastResRedirect('/login', 307), { logger });
        writeWith(() => HttpRes.jsonRes(null, 500), { logger });
        assert.deepEqual(calls, [204, 307, 500]);
    });

    it('HEAD 与空体形态同样记一次', () => {
        const { calls, logger } = spyLogger();
        writeWith(() => HttpRes.jsonRes(undefined), { logger, method: 'HEAD' });
        assert.deepEqual(calls, [200]);
    });

    it('写出本身失败时不记（实际返回码由入口兜底出口写出并记录）', () => {
        const { calls, logger } = spyLogger();
        const res = makeResStub();
        res.setHeader = () => {
            throw new Error('boom');
        };
        runIn(makeCtx({ res, logger }), () => {
            assert.throws(() => HttpRes.fastResRedirect('https://example.test/x'), /boom/);
        });
        assert.deepEqual(calls, []);
    });
});
