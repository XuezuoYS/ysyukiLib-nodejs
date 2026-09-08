import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getCurrentContext, runWithContext, tryGetCurrentContext } from '#YukiLib/httpServer/context';
import { HttpReq } from '#YukiLib/httpServer/httpReq';

import { makeCtx } from './contextFixture.js';

/**
 * 请求上下文（AsyncLocalStorage）语义
 *
 * 覆盖：上下文内可见、上下文外明确失败、异步续接不丢上下文、并发请求互不串数据。
 */
describe('请求上下文', () => {
    it('上下文内 getCurrentContext 返回同一对象', () => {
        const ctx = makeCtx({ requestId: 'ctx-1' });
        runWithContext(ctx, () => {
            assert.equal(getCurrentContext(), ctx);
            assert.equal(HttpReq.getRequestId(), 'ctx-1');
        });
    });

    it('上下文外调用 getCurrentContext 抛出明确错误', () => {
        assert.throws(
            () => getCurrentContext(),
            (err) => /** @type {Error} */ (err).message.includes('不在 HTTP 请求上下文中'),
        );
    });

    it('上下文外 tryGetCurrentContext 返回 null', () => {
        assert.equal(tryGetCurrentContext(), null);
    });

    it('runWithContext 返回 handler 的返回值', () => {
        assert.equal(runWithContext(makeCtx(), () => 42), 42);
    });

    it('await 之后上下文仍然有效（异步续接不丢）', async () => {
        const ctx = makeCtx({ requestId: 'async-1' });
        const seen = await runWithContext(ctx, async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return HttpReq.getRequestId();
        });
        assert.equal(seen, 'async-1');
    });

    it('并发请求各自独立，不串数据', async () => {
        const results = await Promise.all([
            runWithContext(makeCtx({ requestId: 'a', body: { v: 'A' } }), async () => {
                await new Promise((resolve) => setTimeout(resolve, 8));
                return `${HttpReq.getRequestId()}:${HttpReq.getPostData('v')}`;
            }),
            runWithContext(makeCtx({ requestId: 'b', body: { v: 'B' } }), async () => {
                await new Promise((resolve) => setTimeout(resolve, 1));
                return `${HttpReq.getRequestId()}:${HttpReq.getPostData('v')}`;
            }),
        ]);
        assert.deepEqual(results, ['a:A', 'b:B']);
    });
});
