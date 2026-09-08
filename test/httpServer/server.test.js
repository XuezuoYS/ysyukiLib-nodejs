import assert from 'node:assert/strict';
import { after, afterEach, describe, it } from 'node:test';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AppError } from '#YukiLib/httpServer/appError';
import { HttpReq } from '#YukiLib/httpServer/httpReq';
import { HttpServer, normalizePath } from '#YukiLib/httpServer/server';
import { HttpRes } from '#YukiLib/httpServer/httpRes';
import { Logger } from '#YukiLib/logger';
import { Router } from '#YukiLib/httpServer/router';

/**
 * HttpServer 集成测试（真实监听 127.0.0.1 临时端口）
 *
 * 覆盖：上下文建立、路径参数注入、返回值自动序列化、请求体解析与上限、
 * 404/405/AppError/未捕获/已写出 五条兜底分支、HEAD 抑制、中间件洋葱、并发隔离。
 */

const SERVICE_NAME = 'test-service';

/** 日志目录重定向到临时目录，避免污染库自身目录 */
const logDir = mkdtempSync(join(tmpdir(), 'ysyuki-server-log-'));
Logger.logDir = logDir;

/** @type {HttpServer[]} */
const startedServers = [];

after(async () => {
    await Promise.all(startedServers.map((server) => server.close()));
    Logger.logDir = null;
    rmSync(logDir, { recursive: true, force: true });
});

/**
 * 启动临时服务并返回基地址
 *
 * @param {(router: Router) => void} configure 路由配置
 * @param {Record<string, any>} [options] 服务选项覆盖
 * @returns {Promise<string>} 基地址
 */
async function startServer(configure, options = {}) {
    const router = new Router();
    configure(router);
    const server = HttpServer.create({
        router,
        serviceName: SERVICE_NAME,
        host: '127.0.0.1',
        port: 0,
        gracefulShutdown: false,
        exitOnShutdown: false,
        ...options,
    });
    await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(undefined));
    });
    startedServers.push(server);
    return `http://127.0.0.1:${server.port}`;
}

/**
 * 发送 JSON POST
 *
 * @param {string} url 完整地址
 * @param {any} body 请求体
 * @returns {Promise<{status: number, headers: Headers, text: string}>} 响应
 */
async function postJson(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, text: await res.text() };
}

describe('HttpServer：上下文与一行式', () => {
    it('返回值自动序列化：JSON 200 + 4 空格缩进', async () => {
        const base = await startServer((router) => {
            router.get('/auto', () => ({ ok: true }));
        });
        const res = await fetch(`${base}/auto`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
        assert.equal(await res.text(), '{\n    "ok": true\n}');
    });

    it('路径参数按类型注入首参，ctx 为第二参', async () => {
        const base = await startServer((router) => {
            router.get('/users/{uid:int}/{name:alpha}', (params, ctx) => ({
                uid: params.uid,
                uidType: typeof params.uid,
                name: params.name,
                path: ctx.path,
                method: ctx.method,
            }));
        });
        const res = await fetch(`${base}/users/42/neo`);
        assert.deepEqual(await res.json(), {
            uid: 42,
            uidType: 'number',
            name: 'neo',
            path: '/users/42/neo',
            method: 'GET',
        });
    });

    it('HttpReq 一行式取值：请求体、查询串、路径参数、请求头、requestId', async () => {
        const base = await startServer((router) => {
            router.post('/login/{uid:int}', () => {
                const username = HttpReq.getPostData('username', 'string');
                const remember = HttpReq.getPostData('remember', 'bool', false);
                const page = HttpReq.getQuery('page', 'int', 1);
                const uid = HttpReq.getParam('uid', 'int');
                const ua = HttpReq.getHeader('user-agent', '');
                return { username, remember, page, uid, ua, requestId: HttpReq.getRequestId() };
            });
        });
        const res = await fetch(`${base}/login/7?page=3`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'user-agent': 'probe/1', 'x-request-id': 'rid-1' },
            body: JSON.stringify({ username: 'neo' }),
        });
        assert.deepEqual(await res.json(), {
            username: 'neo',
            remember: false,
            page: 3,
            uid: 7,
            ua: 'probe/1',
            requestId: 'rid-1',
        });
    });

    it('并发请求互不串数据', async () => {
        const base = await startServer((router) => {
            router.post('/echo', async () => {
                await new Promise((resolve) => setTimeout(resolve, 10));
                return { v: HttpReq.getPostData('v', 'string') };
            });
        });
        const [a, b] = await Promise.all([
            postJson(`${base}/echo`, { v: 'A' }),
            postJson(`${base}/echo`, { v: 'B' }),
        ]);
        assert.equal(JSON.parse(a.text).v, 'A');
        assert.equal(JSON.parse(b.text).v, 'B');
    });
});

describe('HttpServer：请求体解析与上限', () => {
    it('非法 JSON：400 参数错误', async () => {
        const base = await startServer((router) => {
            router.post('/x', () => ({ ok: true }));
        });
        const res = await postJson(`${base}/x`, 'not json');
        assert.equal(res.status, 400);
        assert.deepEqual(JSON.parse(res.text), { status: '参数错误' });
    });

    it('空请求体：按空对象处理（字段缺失走默认值/400）', async () => {
        const base = await startServer((router) => {
            router.post('/x', () => ({ v: HttpReq.getPostData('v', 'string', 'def') }));
        });
        const res = await postJson(`${base}/x`, '');
        assert.equal(res.status, 200);
        assert.deepEqual(JSON.parse(res.text), { v: 'def' });
    });

    it('超过 bodyLimit：413 请求体过大', async () => {
        const base = await startServer((router) => {
            router.post('/x', () => ({ ok: true }));
        }, { bodyLimit: 32 });
        const res = await postJson(`${base}/x`, { big: 'x'.repeat(200) });
        assert.equal(res.status, 413);
        assert.deepEqual(JSON.parse(res.text), { status: '请求体过大' });
    });

    it('超限后连接可继续复用：剩余请求体被读掉，下一请求正常', async () => {
        const base = await startServer((router) => {
            router.post('/x', () => ({ ok: true }));
        }, { bodyLimit: 1024 });
        const port = Number(new URL(base).port);

        /** 在固定 keep-alive 连接上发一个 POST，返回结果或错误码 */
        const send = (agent, body) => new Promise((resolve) => {
            const req = http.request({
                host: '127.0.0.1',
                port,
                path: '/x',
                method: 'POST',
                agent,
                headers: { 'content-type': 'application/json' },
            }, (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => resolve({
                    status: res.statusCode,
                    body: Buffer.concat(chunks).toString(),
                }));
            });
            req.on('error', (/** @type {any} */ err) => resolve({ error: err.code ?? err.message }));
            req.end(body);
        });

        const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
        try {
            const oversized = await send(agent, JSON.stringify({ big: 'x'.repeat(2 * 1024 * 1024) }));
            assert.equal(oversized.status, 413, `超限请求应收到 413，实际 ${JSON.stringify(oversized)}`);
            assert.deepEqual(JSON.parse(oversized.body), { status: '请求体过大' });

            // 修复前：超限即抛、剩余请求体留在连接里，复用同一连接的下一个请求直接 ECONNRESET
            const next = await send(agent, '{"a":1}');
            assert.equal(next.error, undefined, `超限后的下一个请求不应失败：${JSON.stringify(next)}`);
            assert.equal(next.status, 200);
            assert.deepEqual(JSON.parse(next.body), { ok: true });
        } finally {
            agent.destroy();
        }
    });
});

describe('HttpServer：路径标准化（连续斜杠折叠）', () => {
    it('normalizePath：连续斜杠（两个及以上）折叠为一个，其余行为不变', () => {
        const cases = [
            ['/', ''],
            ['', ''],
            ['a', '/a'],
            ['/a', '/a'],
            ['/a/', '/a'],
            ['//a', '/a'],
            ['///a', '/a'],
            ['/a//b', '/a/b'],
            ['/a///b', '/a/b'],
            ['//a///b/', '/a/b'],
            ['///health///', '/health'],
            ['//', ''],
            ['///', ''],
            ['/a/b//', '/a/b'],
            ['/%2e%2e/admin', '/../admin'],
            ['/a%20b', '/a b'],
            ['/a%2Fb', '/a%2Fb'],
            ['/%ZZ', '/%ZZ'],
        ];
        for (const [input, expected] of cases) {
            assert.equal(normalizePath(input), expected, `normalizePath(${JSON.stringify(input)})`);
        }
    });

    it('多写斜杠的请求与单斜杠请求命中同一路由', async () => {
        const base = await startServer((router) => {
            router.get('/a/b', (_params, ctx) => ({ path: ctx.path }));
        });
        for (const raw of ['/a/b', '/a/b/', '//a/b', '///a///b///']) {
            const res = await fetch(`${base}${raw}`);
            assert.equal(res.status, 200, `${raw} 应命中路由`);
            assert.deepEqual(await res.json(), { path: '/a/b' }, `${raw} 归一化结果`);
        }
    });
});

describe('HttpServer：兜底分支', () => {
    it('404：维持既有响应体形状', async () => {
        const base = await startServer((router) => {
            router.get('/known', () => ({}));
        });
        const res = await fetch(`${base}/missing`);
        assert.equal(res.status, 404);
        assert.deepEqual(await res.json(), {
            name: SERVICE_NAME,
            error: '404 not found',
            path: '/missing',
            method: 'GET',
        });
    });

    it('405：维持既有响应体形状并带 Allow 头', async () => {
        const base = await startServer((router) => {
            router.get('/only-get', () => ({}));
            router.post('/only-get', () => ({}));
        });
        const res = await fetch(`${base}/only-get`, { method: 'DELETE' });
        assert.equal(res.status, 405);
        assert.equal(res.headers.get('allow'), 'GET, POST');
        assert.deepEqual(await res.json(), {
            name: SERVICE_NAME,
            error: '405 method not allowed',
            path: '/only-get',
            method: 'DELETE',
        });
    });

    it('AppError：{status: message} + statusCode', async () => {
        const base = await startServer((router) => {
            router.post('/boom', () => {
                throw new AppError('密钥错误', 401);
            });
        });
        const res = await postJson(`${base}/boom`, {});
        assert.equal(res.status, 401);
        assert.deepEqual(JSON.parse(res.text), { status: '密钥错误' });
    });

    it('未捕获异常：500 契约体，堆栈不外泄，onError 钩子被调用', async () => {
        /** @type {any[]} */
        const captured = [];
        const base = await startServer((router) => {
            router.get('/crash', () => {
                throw new TypeError('内部细节不应外泄');
            });
        }, { onError: (err) => captured.push(err) });

        const res = await fetch(`${base}/crash`);
        assert.equal(res.status, 500);
        const body = await res.json();
        assert.deepEqual(body, { status: '服务器内部错误' });
        assert.equal(captured.length, 1);
        assert.ok(captured[0] instanceof TypeError);
    });

    it('HttpRes.cookie 非法名：服务端编程错误 → 500 + onError 收到普通 Error', async () => {
        /** @type {any[]} */
        const captured = [];
        const base = await startServer((router) => {
            router.get('/bad-cookie', () => {
                HttpRes.cookie('bad name', 'v');
                return { ok: true };
            });
        }, { onError: (err) => captured.push(err) });

        const res = await fetch(`${base}/bad-cookie`);
        assert.equal(res.status, 500);
        assert.deepEqual(await res.json(), { status: '服务器内部错误' });
        assert.equal(captured.length, 1);
        assert.ok(captured[0] instanceof Error);
        assert.equal(captured[0] instanceof AppError, false);
        assert.match(captured[0].message, /Cookie 名非法/);
    });

    it('响应已开始后异常：终结响应，客户端不挂起，onError 被调用', async () => {
        /** @type {any[]} */
        const captured = [];
        const base = await startServer((router) => {
            router.get('/partial', (params, ctx) => {
                ctx.res.writeHead(200, { 'content-type': 'text/plain' });
                ctx.res.write('partial');          // 已开始写出
                throw new Error('写出到一半失败');  // 此时无法再改状态码
            });
        }, { onError: (err) => captured.push(err) });

        // 修复前：兜底分支只记日志不终结响应，客户端会一直等到 requestTimeout
        const settled = await Promise.race([
            fetch(`${base}/partial`).then(
                (res) => res.text().then(
                    () => 'text-ok',
                    () => 'body-error',
                ),
                () => 'fetch-error',
            ),
            new Promise((resolve) => setTimeout(() => resolve('timeout'), 3000)),
        ]);
        assert.notEqual(settled, 'timeout', '客户端不应挂起等待永不结束的响应');
        assert.equal(captured.length, 1);
        assert.match(captured[0].message, /写出到一半失败/);
    });

    it('处理器无输出：补空 200（无 Content-Type）', async () => {
        const base = await startServer((router) => {
            router.get('/empty', () => {});
        });
        const res = await fetch(`${base}/empty`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), null);
        assert.equal(await res.text(), '');
    });
});

describe('HttpServer：HTTP 语义', () => {
    it('HEAD：命中 GET 路由，响应头照常、响应体抑制', async () => {
        const base = await startServer((router) => {
            router.get('/head', () => ({ ok: true }));
        });
        const res = await fetch(`${base}/head`, { method: 'HEAD' });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
        assert.equal(await res.text(), '');
    });

    it('HttpRes.fastResRedirect：307 + Location，无响应体', async () => {
        const base = await startServer((router) => {
            router.get('/go', () => {
                HttpRes.fastResRedirect('/target', 303);
            });
        });
        const res = await fetch(`${base}/go`, { redirect: 'manual' });
        assert.equal(res.status, 303);
        assert.equal(res.headers.get('location'), '/target');
        assert.equal(await res.text(), '');
    });

    it('中间件洋葱：全局中间件包裹处理器，ctx.state 可共享', async () => {
        /** @type {string[]} */
        const trace = [];
        const base = await startServer((router) => {
            router.use(async (ctx, next) => {
                trace.push('global-in');
                ctx.state.mark = 'mw';
                await next();
                trace.push('global-out');
            });
            router.get('/onion', (_params, ctx) => {
                trace.push('handler');
                return { mark: ctx.state.mark };
            });
        });
        const res = await fetch(`${base}/onion`);
        assert.deepEqual(await res.json(), { mark: 'mw' });
        assert.deepEqual(trace, ['global-in', 'handler', 'global-out']);
    });

    it('分组中间件只作用于该分组路由', async () => {
        const base = await startServer((router) => {
            router.group('/v1', (v1) => {
                v1.use(async (ctx, next) => {
                    ctx.state.scope = 'v1';
                    await next();
                });
                v1.get('/in', (_params, ctx) => ({ scope: ctx.state.scope ?? null }));
            });
            router.get('/out', (_params, ctx) => ({ scope: ctx.state.scope ?? null }));
        });
        assert.deepEqual(await (await fetch(`${base}/v1/in`)).json(), { scope: 'v1' });
        assert.deepEqual(await (await fetch(`${base}/out`)).json(), { scope: null });
    });
});

describe('HttpServer：优雅关闭（进程级共享信号注册）', () => {
    /** 基线监听器数量（本文件其它用例均为 gracefulShutdown: false，不注册信号） */
    const baseline = {
        SIGINT: process.listenerCount('SIGINT'),
        SIGTERM: process.listenerCount('SIGTERM'),
    };

    /** @type {HttpServer[]} */
    const gracefulServers = [];

    afterEach(async () => {
        await Promise.all(gracefulServers.map((server) => server.close()));
        gracefulServers.length = 0;
    });

    /**
     * 启动一个注册信号监听的临时服务
     *
     * @param {Record<string, any>} [options] 选项覆盖
     * @param {(router: Router) => void} [configure] 路由配置
     * @returns {Promise<{server: HttpServer, base: string}>} 实例与基地址
     */
    async function startGraceful(options = {}, configure = (router) => {
        router.get('/ping', () => ({ ok: true }));
    }) {
        const router = new Router();
        configure(router);
        const server = HttpServer.create({
            router,
            serviceName: SERVICE_NAME,
            host: '127.0.0.1',
            port: 0,
            gracefulShutdown: true,
            ...options,
        });
        await new Promise((resolve) => {
            server.listen(0, '127.0.0.1', () => resolve(undefined));
        });
        gracefulServers.push(server);
        return { server, base: `http://127.0.0.1:${server.port}` };
    }

    /**
     * 等待服务不再接受连接
     *
     * @param {string} base 基地址
     * @returns {Promise<void>}
     */
    async function waitClosed(base) {
        for (let i = 0; i < 200; i += 1) {
            try {
                await fetch(`${base}/ping`);
            } catch {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`服务未在预期时间内关闭：${base}`);
    }

    it('多实例只装一组进程监听器，全部 close 后移除', async () => {
        const a = await startGraceful();
        const b = await startGraceful();
        assert.equal(process.listenerCount('SIGTERM'), baseline.SIGTERM + 1);
        assert.equal(process.listenerCount('SIGINT'), baseline.SIGINT + 1);

        await a.server.close();
        assert.equal(process.listenerCount('SIGTERM'), baseline.SIGTERM + 1, '仍有实例注册时应保留监听器');

        await b.server.close();
        assert.equal(process.listenerCount('SIGTERM'), baseline.SIGTERM);
        assert.equal(process.listenerCount('SIGINT'), baseline.SIGINT);
    });

    it('收到 SIGTERM：关闭全部已注册实例并移除监听器（默认不退出进程）', async () => {
        const a = await startGraceful();
        const b = await startGraceful();

        process.emit('SIGTERM');

        await waitClosed(a.base);
        await waitClosed(b.base);
        assert.equal(process.listenerCount('SIGTERM'), baseline.SIGTERM);
        assert.equal(process.listenerCount('SIGINT'), baseline.SIGINT);
    });

    it('仅部分实例 exitOnShutdown 为 true：不结束进程', async () => {
        const a = await startGraceful({ exitOnShutdown: true });
        const b = await startGraceful({ exitOnShutdown: false });

        process.emit('SIGTERM');

        await waitClosed(a.base);
        await waitClosed(b.base);
        // 能执行到这一行即证明进程未被结束
        assert.equal(process.listenerCount('SIGTERM'), baseline.SIGTERM);
    });

    it('关闭超时：强制断开在途连接', async () => {
        const { base } = await startGraceful({ shutdownTimeout: 80 }, (router) => {
            router.get('/hang', () => new Promise(() => {}));
        });

        const pending = fetch(`${base}/hang`);
        pending.catch(() => {}); // 避免未处理的拒绝
        await new Promise((resolve) => setTimeout(resolve, 30)); // 等请求到达服务端

        process.emit('SIGTERM');

        await assert.rejects(() => pending);
        assert.equal(process.listenerCount('SIGTERM'), baseline.SIGTERM);
    });
});
