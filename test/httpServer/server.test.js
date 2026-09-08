import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AppError } from '#YukiLib/httpServer/appError';
import { HttpReq } from '#YukiLib/httpServer/httpReq';
import { HttpServer } from '#YukiLib/httpServer/server';
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
