import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError } from '#YukiLib/httpServer/appError';
import { Middleware } from '#YukiLib/httpServer/middleware';
import { HttpRes } from '#YukiLib/httpServer/httpRes';
import { compose } from '#YukiLib/httpServer/onion';

import { makeCtx, makeResStub, runIn } from './contextFixture.js';

/**
 * 内置可选中间件
 *
 * 覆盖：CORS 响应头与预检短路、访问日志（响应 finish 时输出）、请求标识回写。
 */

/**
 * 构造「上下文 + 响应替身」组合（断言直接看替身，避开 ServerResponse 类型）
 *
 * @default options = {}
 * @param {Record<string, any>} [options] makeCtx 选项
 * @returns {{ctx: import('#YukiLib/httpServer/context').HttpContext, res: import('./contextFixture.js').ResStub}} 组合
 */
function makeCase(options = {}) {
    const res = makeResStub();
    const ctx = makeCtx({ ...options, res });
    return { ctx, res };
}

/**
 * 执行「中间件 + 处理器」链
 *
 * @default handler = () => {}
 * @param {import('#YukiLib/httpServer/onion').Middleware} middleware 中间件
 * @param {import('#YukiLib/httpServer/context').HttpContext} ctx 上下文
 * @param {() => any} [handler] 处理器
 * @returns {Promise<boolean>} 处理器是否被执行
 */
async function runChain(middleware, ctx, handler = () => {}) {
    let called = false;
    await runIn(ctx, () => compose([middleware, async () => {
        called = true;
        handler();
    }])(ctx));
    return called;
}

describe('Middleware.cors', () => {
    it('默认：设置通配 Allow-Origin，GET 正常进入处理器', async () => {
        const { ctx, res } = makeCase({ method: 'GET' });
        const called = await runChain(Middleware.cors(), ctx);
        assert.equal(called, true);
        assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
        assert.equal(res.headers['Access-Control-Allow-Credentials'], undefined);
        assert.equal(res.headers.Vary, undefined);
    });

    it('OPTIONS 预检：204 短路，处理器不执行，带方法/头/缓存头', async () => {
        const { ctx, res } = makeCase({ method: 'OPTIONS' });
        const called = await runChain(Middleware.cors(), ctx);
        assert.equal(called, false);
        assert.equal(res.statusCode, 204);
        assert.equal(res.headers['Access-Control-Allow-Methods'], 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS');
        assert.equal(res.headers['Access-Control-Allow-Headers'], 'Content-Type, Authorization, X-Request-Id');
        assert.equal(res.headers['Access-Control-Max-Age'], '86400');
        assert.equal(res.ended, true);
    });

    it('credentials：须显式 origin，回显该 origin 并声明凭证许可', async () => {
        const { ctx, res } = makeCase({ method: 'GET' });
        await runChain(Middleware.cors({ credentials: true, origin: 'https://app.test' }), ctx);
        assert.equal(res.headers['Access-Control-Allow-Origin'], 'https://app.test');
        assert.equal(res.headers['Access-Control-Allow-Credentials'], 'true');
        assert.equal(res.headers.Vary, 'Origin');
    });

    it('credentials: true 但 origin 未指定 / 为空 / 为 "*"：构造时抛 Error', () => {
        for (const options of [
            { credentials: true },
            { credentials: true, origin: '' },
            { credentials: true, origin: '*' },
        ]) {
            assert.throws(
                () => Middleware.cors(options),
                (err) => err instanceof Error
                    && !(err instanceof AppError)
                    && err.message.includes('credentials: true 时必须显式指定非 "*" 的 origin'),
                `应抛错：${JSON.stringify(options)}`,
            );
        }
    });

    it('Vary 追加而非覆盖：宿主已设的 Vary 保留', async () => {
        const { ctx, res } = makeCase({ method: 'GET' });
        res.setHeader('Vary', 'Accept-Encoding');
        await runChain(Middleware.cors({ origin: 'https://a.test' }), ctx);
        assert.equal(res.headers.Vary, 'Accept-Encoding, Origin');
    });

    it('Vary 已含 Origin（大小写不敏感）时不重复追加', async () => {
        const { ctx, res } = makeCase({ method: 'GET' });
        res.setHeader('Vary', 'origin');
        await runChain(Middleware.cors({ origin: 'https://a.test' }), ctx);
        assert.equal(res.headers.Vary, 'origin');
    });

    it('自定义 origin / methods / maxAge', async () => {
        const { ctx, res } = makeCase({ method: 'OPTIONS' });
        await runChain(Middleware.cors({ origin: 'https://a.test', methods: 'GET', maxAge: 60 }), ctx);
        assert.equal(res.headers['Access-Control-Allow-Origin'], 'https://a.test');
        assert.equal(res.headers['Access-Control-Allow-Methods'], 'GET');
        assert.equal(res.headers['Access-Control-Max-Age'], '60');
    });

    it('preflight: false：OPTIONS 继续进入处理器', async () => {
        const { ctx } = makeCase({ method: 'OPTIONS' });
        const called = await runChain(Middleware.cors({ preflight: false }), ctx);
        assert.equal(called, true);
    });
});

describe('Middleware.accessLog', () => {
    /**
     * 构造带 access 捕获的上下文（访问日志由 ctx.logger.access 输出）
     *
     * @default options = {}
     * @param {Record<string, any>} [options] makeCtx 选项
     * @returns {{ctx: import('#YukiLib/httpServer/context').HttpContext, captured: any[]}} 上下文与捕获数组
     */
    function makeAccessCase(options = {}) {
        const ctx = makeCtx(options);
        /** @type {any[]} */
        const captured = [];
        ctx.logger.access = (status, ms) => captured.push({ status, ms });
        return { ctx, captured };
    }

    it('响应 finish 时输出访问日志，状态码为最终值', async () => {
        const { ctx, captured } = makeAccessCase({ method: 'POST', path: '/api/v1/x' });
        await runIn(ctx, () => compose([
            Middleware.accessLog(),
            async () => {
                HttpRes.jsonRes({ ok: true }, 201);
            },
        ])(ctx));

        assert.equal(captured.length, 1);
        assert.equal(captured[0].status, 201);
        assert.equal(typeof captured[0].ms, 'number');
    });

    it('处理器未写响应时不输出（finish 未触发）', async () => {
        const { ctx, captured } = makeAccessCase();
        await runChain(Middleware.accessLog(), ctx);
        assert.equal(captured.length, 0);
    });
});

describe('Middleware.requestId', () => {
    it('默认回写 X-Request-Id', async () => {
        const { ctx, res } = makeCase({ requestId: 'rid-42' });
        await runChain(Middleware.requestId(), ctx);
        assert.equal(res.headers['X-Request-Id'], 'rid-42');
    });

    it('自定义头名', async () => {
        const { ctx, res } = makeCase({ requestId: 'rid-7' });
        await runChain(Middleware.requestId({ header: 'X-Trace-Id' }), ctx);
        assert.equal(res.headers['X-Trace-Id'], 'rid-7');
    });
});
