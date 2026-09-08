import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compose } from '#YukiLib/httpServer/onion';

/**
 * 中间件洋葱组合
 *
 * 覆盖：执行顺序（进出成对）、next() 传递、重复调用 next() 抛错、空中间件数组。
 */
describe('中间件洋葱 compose', () => {
    it('进出顺序为洋葱模型', async () => {
        /** @type {string[]} */
        const trace = [];
        const run = compose([
            async (ctx, next) => { trace.push('a-in'); await next(); trace.push('a-out'); },
            async (ctx, next) => { trace.push('b-in'); await next(); trace.push('b-out'); },
            async () => { trace.push('handler'); },
        ]);
        await run({});
        assert.deepEqual(trace, ['a-in', 'b-in', 'handler', 'b-out', 'a-out']);
    });

    it('中间件可修改 ctx 并传给后续环节', async () => {
        const run = compose([
            async (ctx, next) => { ctx.user = 'u1'; await next(); },
            async (ctx) => { ctx.seen = ctx.user; },
        ]);
        const ctx = /** @type {any} */ ({});
        await run(ctx);
        assert.equal(ctx.seen, 'u1');
    });

    it('不调用 next 时后续环节不执行', async () => {
        /** @type {string[]} */
        const trace = [];
        const run = compose([
            async () => { trace.push('a'); },
            async () => { trace.push('b'); },
        ]);
        await run({});
        assert.deepEqual(trace, ['a']);
    });

    it('同一中间件重复调用 next()：抛明确错误', async () => {
        const run = compose([
            async (ctx, next) => { await next(); await next(); },
            async () => {},
        ]);
        await assert.rejects(() => run({}), /next\(\) 被重复调用/);
    });

    it('空中间件数组：直接返回', async () => {
        const run = compose([]);
        await run({});
        assert.ok(true);
    });
});
