import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AppError } from '#YukiLib/httpServer/appError';
import { HttpReq } from '#YukiLib/httpServer/httpReq';
import { HttpServer, normalizePath, parseFormBody } from '#YukiLib/httpServer/server';
import { HttpRes } from '#YukiLib/httpServer/httpRes';
import { Logger } from '#YukiLib/logger';
import { Middleware } from '#YukiLib/httpServer/middleware';
import { Router } from '#YukiLib/httpServer/router';

import { captureStdoutAsync } from '../loggerFixture.js';
import { listenOnFetchablePort } from './fetchPortFixture.js';

/**
 * HttpServer 集成测试（真实监听 127.0.0.1 临时端口）
 *
 * 覆盖：上下文建立、路径参数注入、返回值自动序列化、请求体解析与上限、
 * 404/405/AppError/未捕获/已写出 五条兜底分支、HEAD 抑制、中间件洋葱、并发隔离。
 *
 * 端口一律由系统分配后经 `listenOnFetchablePort` 过一遍：`listen(0)` 偶尔会分到
 * WHATWG fetch 的禁端口，`fetch()` 在建连前就报 `bad port`（与被测代码无关的随机红）。
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
 * @default options = {}
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
    startedServers.push(server);
    const port = await listenHttpServer(server);
    return `http://127.0.0.1:${port}`;
}

/**
 * 启动监听并返回可被 fetch 使用的端口
 *
 * 系统偶尔把 WHATWG fetch 的禁端口（见 fetchPortFixture.js）分配给 `listen(0)`，
 * 之后每个 `fetch()` 都在建连前抛 `bad port`，用例随机红；这里避开这些端口重听。
 * 夹具自身的用例（含"关闭后能重新监听"这条真实往返）在 fetchPortFixture.test.js。
 *
 * @param {HttpServer} server 未启动的服务
 * @returns {Promise<number>} 实际监听端口
 */
async function listenHttpServer(server) {
    return listenOnFetchablePort(
        () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.port))),
        () => server.close(),
    );
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

/**
 * 发一条 GET：若在 timeoutMs 内收不到响应即判定为"服务端未写响应"
 *
 * 用于验证 `emptyResponse: false`（不补空 200）时的挂起语义——此时 fetch 会一直等，
 * 故用可销毁的原始请求，避免在途连接拖住 server.close()。
 *
 * @default timeoutMs = 300
 * @param {number} port 端口
 * @param {string} path 请求路径
 * @param {number} [timeoutMs] 判定未响应的等待上限
 * @returns {Promise<{hung: true} | {hung: false, status: number, text: string}>} 响应或挂起
 */
function getOrHang(port, path, timeoutMs = 300) {
    return new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port, path, agent: false }, (res) => {
            /** @type {Buffer[]} */
            const chunks = [];
            res.on('data', (chunk) => chunks.push(/** @type {Buffer} */ (chunk)));
            res.on('end', () => resolve({
                hung: false,
                status: res.statusCode ?? 0,
                text: Buffer.concat(chunks).toString(),
            }));
        });
        req.on('error', () => resolve({ hung: true }));
        const timer = setTimeout(() => {
            req.destroy();
            resolve({ hung: true });
        }, timeoutMs);
        req.on('close', () => clearTimeout(timer));
        req.end();
    });
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

describe('HttpServer：application/x-www-form-urlencoded 请求体', () => {
    /** 发一个表单编码 POST */
    const postForm = (url, body) => fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
    });

    it('parseFormBody：值与 JSON 同形（+ 即空格、百分号解码、同名键取首值）', () => {
        assert.deepEqual(parseFormBody(''), {});
        assert.deepEqual(parseFormBody('   '), {});
        assert.deepEqual(parseFormBody('a=1&b=x+y'), { a: '1', b: 'x y' });
        assert.deepEqual(parseFormBody('n=%E4%B8%AD%E6%96%87'), { n: '中文' });
        assert.deepEqual(parseFormBody('a=1&a=2'), { a: '1' }, '同名键取首值（与 getQuery 一致）');
        assert.deepEqual(parseFormBody('flag'), { flag: '' }, '无 = 的片段按空串收录');
        assert.deepEqual(parseFormBody('a=%ZZ'), { a: '%ZZ' }, '非法百分号编码原样保留，不抛错');
        assert.deepEqual(parseFormBody('empty='), { empty: '' });
    });

    it('同一处理器：表单与 JSON 两种请求体取值结果一致', async () => {
        const base = await startServer((router) => {
            router.post('/submit', () => ({
                username: HttpReq.getPostData('username', 'string'),
                remember: HttpReq.getPostData('remember', 'bool'),
                page: HttpReq.getPostData('page', 'int'),
                ratio: HttpReq.getPostData('ratio', 'float'),
                missing: HttpReq.getPostData('missing', 'string', 'default'),
            }));
        });

        const expected = {
            username: 'neo',
            remember: true,
            page: 3,
            ratio: 1.5,
            missing: 'default',
        };
        assert.deepEqual(await (await postForm(`${base}/submit`, 'username=neo&remember=true&page=3&ratio=1.5')).json(), expected);

        const jsonRes = await postJson(`${base}/submit`, {
            username: 'neo', remember: true, page: 3, ratio: 1.5,
        });
        assert.deepEqual(JSON.parse(jsonRes.text), expected);
    });

    it('表单体按字符串来源校验：类型不符抛 400（与 query 语义一致）', async () => {
        const base = await startServer((router) => {
            router.post('/int', () => ({ v: HttpReq.getPostData('v', 'int') }));
            router.post('/bool', () => ({ v: HttpReq.getPostData('v', 'bool') }));
            router.post('/array', () => ({ v: HttpReq.getPostData('v', 'array') }));
        });

        for (const [path, body, type] of [['/int', 'v=abc', 'int'], ['/int', 'v=1.5', 'int'], ['/bool', 'v=yes', 'bool'], ['/array', 'v=a&v=b', 'array']]) {
            const res = await postForm(`${base}${path}`, body);
            assert.equal(res.status, 400, `${path}?${body} 应 400`);
            assert.deepEqual(await res.json(), { status: `类型错误，需要的类型：${type}` });
        }
    });

    it('Content-Type 带 charset 参数同样按表单解析', async () => {
        const base = await startServer((router) => {
            router.post('/x', () => ({ v: HttpReq.getPostData('v', 'int') }));
        });
        const res = await fetch(`${base}/x`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            body: 'v=7',
        });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { v: 7 });
    });

    it('表单体 + 查询串：两种来源各自独立取值', async () => {
        const base = await startServer((router) => {
            router.post('/mix', () => ({
                fromBody: HttpReq.getPostData('page', 'int'),
                fromQuery: HttpReq.getQuery('page', 'int'),
            }));
        });
        const res = await postForm(`${base}/mix?page=9`, 'page=3');
        assert.deepEqual(await res.json(), { fromBody: 3, fromQuery: 9 });
    });

    it('非表单 Content-Type 仍按 JSON 解析：非法 JSON 400', async () => {
        const base = await startServer((router) => {
            router.post('/x', () => ({ ok: true }));
        });
        const res = await fetch(`${base}/x`, {
            method: 'POST',
            headers: { 'content-type': 'text/plain' },
            body: 'a=1',
        });
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), { status: '参数错误' });
    });

    it('表单体同样受 bodyLimit 约束', async () => {
        const base = await startServer((router) => {
            router.post('/x', () => ({ ok: true }));
        }, { bodyLimit: 32 });
        const res = await postForm(`${base}/x`, `big=${'x'.repeat(200)}`);
        assert.equal(res.status, 413);
        assert.deepEqual(await res.json(), { status: '请求体过大' });
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
            status: '404 not found',
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
            status: '405 method not allowed',
            path: '/only-get',
            method: 'DELETE',
        });
    });

    it('路径命中但 int 参数超出可精确表示范围：400 非法参数（不回显 URL 原文）', async () => {
        const base = await startServer((router) => {
            router.get('/user/{id:int}', (params) => ({ id: params.id, type: typeof params.id }));
            router.get('/file/{name}', (params) => ({ name: params.name }));
        });

        // 修复前：…99 与 …98 都命中并给出同一个 1e20（鉴权/查库混淆面）
        for (const url of ['/user/99999999999999999999', '/user/99999999999999999998', `/user/${'9'.repeat(310)}`]) {
            const res = await fetch(`${base}${url}`);
            assert.equal(res.status, 400, `${url} 应判非法参数，而不是静默塌缩`);
            const body = await res.json();
            assert.deepEqual(body, { status: '路径参数 id 不是合法的 int' });
            assert.ok(!JSON.stringify(body).includes('99999999999999'), '不应把 URL 原文回显给客户端');
        }

        // 要原始文本就用 string 段
        const asText = await fetch(`${base}/file/99999999999999999999`);
        assert.equal(asText.status, 200);
        assert.deepEqual(await asText.json(), { name: '99999999999999999999' });

        // 可精确表示的值照常命中；007 → 7 是保留行为
        const ok = await fetch(`${base}/user/007`);
        assert.equal(ok.status, 200);
        assert.deepEqual(await ok.json(), { id: 7, type: 'number' });
    });

    it('400 非法路径参数经 AppError 出口：onError 钩子收到 AppError(400)', async () => {
        /** @type {any[]} */
        const captured = [];
        const base = await startServer((router) => {
            router.get('/user/{id:int}', () => ({}));
        }, { onError: (err) => captured.push(err) });

        const res = await fetch(`${base}/user/${'9'.repeat(310)}`);
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), { status: '路径参数 id 不是合法的 int' });
        assert.equal(captured.length, 1);
        assert.ok(captured[0] instanceof AppError);
        assert.equal(captured[0].statusCode, 400);
    });

    it('any() 路由对非标准动词返回 405，Allow 为展开后的标准方法集合', async () => {
        const base = await startServer((router) => {
            router.any('/x', () => ({ ok: true }));
        });

        assert.equal((await fetch(`${base}/x`, { method: 'DELETE' })).status, 200);
        // PROPFIND 由 Node 的 HTTP 解析器放行（能进到路由层），但不属于标准方法集合
        const miss = await fetch(`${base}/x`, { method: 'PROPFIND' });
        assert.equal(miss.status, 405);
        assert.equal(
            miss.headers.get('allow'),
            'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS, TRACE, CONNECT',
        );
        assert.deepEqual(await miss.json(), {
            name: SERVICE_NAME,
            error: '405 method not allowed',
            path: '/x',
            method: 'PROPFIND',
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

    it('处理器无输出：补空 200（无 Content-Type），且不记 WARN', async () => {
        const logDir = mkdtempSync(join(tmpdir(), 'ysyuki-empty-ok-'));
        const previousDir = Logger.logDir;
        Logger.logDir = logDir;
        try {
            const base = await startServer((router) => {
                router.get('/empty', () => {});
            }, { logLevel: 'warn' });

            /** @type {{status: number, type: string|null, text: string}[]} */
            const results = [];
            const entries = await captureStdoutAsync(async () => {
                // 连发三条：修复前每条都记一次 WARN（"处理器无输出"被误归因为中间件漏调 next()），
                // 高 QPS 空体端点会因此在生产持续刷错日志。
                for (let i = 0; i < 3; i += 1) {
                    const res = await fetch(`${base}/empty`);
                    results.push({
                        status: res.status,
                        type: res.headers.get('content-type'),
                        text: await res.text(),
                    });
                }
            });

            for (const item of results) {
                assert.equal(item.status, 200);
                assert.equal(item.type, null);
                assert.equal(item.text, '');
            }
            // 一个中间件都没注册，谈不上"中间件漏调 next()"：这是文档化的正常路径，静默补空。
            assert.deepEqual(entries.filter((entry) => entry.message.includes('未调用 next()')), []);
        } finally {
            Logger.logDir = previousDir;
            rmSync(logDir, { recursive: true, force: true });
        }
    });

    it('emptyResponse: false：处理器无输出不补空响应（客户端挂起），也不记 WARN', async () => {
        const logDir = mkdtempSync(join(tmpdir(), 'ysyuki-empty-off-'));
        const previousDir = Logger.logDir;
        Logger.logDir = logDir;
        try {
            const base = await startServer((router) => {
                router.get('/empty', () => {});
            }, { logLevel: 'warn', emptyResponse: false });

            /** @type {any} */
            let outcome;
            const entries = await captureStdoutAsync(async () => {
                outcome = await getOrHang(Number(new URL(base).port), '/empty');
            });

            // 关补空后不写任何响应——这是宿主显式选择的行为，不得归责于框架/中间件。
            assert.equal(outcome.hung, true, '关闭补空后处理器无输出应无任何响应');
            assert.deepEqual(entries.filter((entry) => entry.message.includes('未调用 next()')), []);
        } finally {
            Logger.logDir = previousDir;
            rmSync(logDir, { recursive: true, force: true });
        }
    });
});

describe('HttpServer：HTTP 语义', () => {
    it('HEAD：命中 GET 路由，响应头照常、响应体抑制', async () => {
        const base = await startServer((router) => {
            router.get('/head', () => ({ ok: true, text: '中文' }));
        });
        const getRes = await fetch(`${base}/head`);
        const getBody = await getRes.text();

        const res = await fetch(`${base}/head`, { method: 'HEAD' });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
        assert.equal(await res.text(), '');
        // L5：HEAD 头部应与 GET 一致——必须带 Content-Length（按字节数，非字符数）
        assert.equal(res.headers.get('content-length'), String(Buffer.byteLength(getBody, 'utf8')));
        assert.equal(res.headers.get('content-length'), getRes.headers.get('content-length'));
    });

    it('HEAD + jsonRes() 空体形态：200 且 Content-Length: 0（不再 500）', async () => {
        const base = await startServer((router) => {
            router.get('/void', () => {
                HttpRes.jsonRes(undefined);
            });
        });
        const getRes = await fetch(`${base}/void`);
        assert.equal(getRes.status, 200);
        assert.equal(getRes.headers.get('content-type'), 'application/json; charset=utf-8');
        assert.equal(await getRes.text(), '');

        const res = await fetch(`${base}/void`, { method: 'HEAD' });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
        assert.equal(await res.text(), '');
        // 与 GET 一致：GET 的空体是 Content-Length: 0
        assert.equal(res.headers.get('content-length'), getRes.headers.get('content-length'));
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

    it('中间件忘记调用 next()：补空 200 并记 WARN（不静默）', async () => {
        const logDir = mkdtempSync(join(tmpdir(), 'ysyuki-mw-warn-'));
        const previousDir = Logger.logDir;
        Logger.logDir = logDir;
        try {
            const base = await startServer((router) => {
                router.use(async () => { /* 既没 next()，也没写响应 */ });
                router.get('/x', () => ({ never: true }));
            }, { logLevel: 'warn' });

            const entries = await captureStdoutAsync(async () => {
                const res = await fetch(`${base}/x`);
                assert.equal(res.status, 200);
                assert.equal(await res.text(), '');
            });
            const warned = entries.filter((entry) => entry.message.includes('未调用 next()'));
            assert.equal(warned.length, 1);
            assert.equal(warned[0].level, 'WARN');
            assert.equal(warned[0].fields.path, '/x');
            assert.match(warned[0].message, /已补空 200/);
        } finally {
            Logger.logDir = previousDir;
            rmSync(logDir, { recursive: true, force: true });
        }
    });

    it('分组/路由级中间件忘记调用 next()：同样记 WARN（处理器未被派发）', async () => {
        const logDir = mkdtempSync(join(tmpdir(), 'ysyuki-mw-route-'));
        const previousDir = Logger.logDir;
        Logger.logDir = logDir;
        try {
            const base = await startServer((router) => {
                router.get('/leak', () => ({ never: true }), {
                    middleware: [async () => { /* 路由级：既没 next()，也没写响应 */ }],
                });
                router.group('/g', (r) => {
                    r.use(async () => { /* 分组级：既没 next()，也没写响应 */ });
                    r.get('/x', () => ({ never: true }));
                });
            }, { logLevel: 'warn' });

            /** @type {any[]} */
            const results = [];
            const entries = await captureStdoutAsync(async () => {
                for (const path of ['/leak', '/g/x']) {
                    const res = await fetch(`${base}${path}`);
                    results.push({ status: res.status, text: await res.text() });
                }
            });

            for (const item of results) {
                assert.equal(item.status, 200);
                assert.equal(item.text, '');
            }
            const warned = entries.filter((entry) => entry.message.includes('未调用 next()'));
            assert.equal(warned.length, 2);
            assert.deepEqual(warned.map((entry) => entry.fields.path), ['/leak', '/g/x']);
        } finally {
            Logger.logDir = previousDir;
            rmSync(logDir, { recursive: true, force: true });
        }
    });

    it('emptyResponse: false 时中间件漏调 next()：仍记 WARN（不再静默），且不补空响应', async () => {
        const logDir = mkdtempSync(join(tmpdir(), 'ysyuki-mw-off-'));
        const previousDir = Logger.logDir;
        Logger.logDir = logDir;
        try {
            const base = await startServer((router) => {
                router.use(async () => { /* 既没 next()，也没写响应 */ });
                router.get('/x', () => ({ never: true }));
            }, { logLevel: 'warn', emptyResponse: false });

            /** @type {any} */
            let outcome;
            const entries = await captureStdoutAsync(async () => {
                outcome = await getOrHang(Number(new URL(base).port), '/x');
            });

            assert.equal(outcome.hung, true, '关闭补空后不应有任何响应写出');
            const warned = entries.filter((entry) => entry.message.includes('未调用 next()'));
            assert.equal(warned.length, 1);
            assert.equal(warned[0].level, 'WARN');
            assert.equal(warned[0].fields.path, '/x');
            // 告警文案不得声称"已补空 200"——本次并未补空
            assert.match(warned[0].message, /emptyResponse 已关闭/);
        } finally {
            Logger.logDir = previousDir;
            rmSync(logDir, { recursive: true, force: true });
        }
    });

    it('正常调用 next() 与主动写响应的短路中间件都不告警', async () => {
        const logDir = mkdtempSync(join(tmpdir(), 'ysyuki-mw-ok-'));
        const previousDir = Logger.logDir;
        Logger.logDir = logDir;
        try {
            const base = await startServer((router) => {
                router.use(async (ctx, next) => {         // 正常洋葱
                    await next();
                });
                router.use(async (ctx, next) => {         // 主动短路：写响应后不调 next()
                    if (ctx.path === '/short') {
                        HttpRes.status(204);
                        HttpRes.fastResEmpty();
                        return;
                    }
                    await next();
                });
                router.get('/x', () => ({ ok: true }));
                router.get('/short', () => ({ never: true }));
            }, { logLevel: 'warn' });

            const entries = await captureStdoutAsync(async () => {
                const ok = await fetch(`${base}/x`);
                assert.deepEqual(await ok.json(), { ok: true });

                const shorted = await fetch(`${base}/short`);
                assert.equal(shorted.status, 204);
                assert.equal(await shorted.text(), '');
            });
            assert.deepEqual(entries.filter((entry) => entry.message.includes('未调用 next()')), []);
        } finally {
            Logger.logDir = previousDir;
            rmSync(logDir, { recursive: true, force: true });
        }
    });
});

describe('HttpServer：全局中间件先于路由决策（方案 A）', () => {
    /** 记录全局中间件覆盖到的请求 */
    const seen = [];
    let base = '';

    before(async () => {
        base = await startServer((router) => {
            router.use(Middleware.cors({ origin: 'https://app.test' }));
            router.use(async (ctx, next) => {
                seen.push(`${ctx.method} ${ctx.path}`);
                await next();
            });
            router.get('/x', () => ({ ok: true }));
            router.post('/x', () => ({ ok: true }));
        });
    });

    after(() => {
        seen.length = 0;
    });

    it('CORS 预检短路：204 + 跨域头，不再被 405 拒掉', async () => {
        // 真实浏览器预检：OPTIONS + Access-Control-Request-Method，无请求体
        const res = await fetch(`${base}/x`, {
            method: 'OPTIONS',
            headers: { origin: 'https://app.test', 'access-control-request-method': 'POST' },
        });
        assert.equal(res.status, 204);
        assert.equal(res.headers.get('access-control-allow-origin'), 'https://app.test');
        assert.match(res.headers.get('access-control-allow-methods'), /POST/);
        assert.equal(await res.text(), '');
    });

    it('404 / 405 也经过全局中间件，因此带上跨域头', async () => {
        const notFound = await fetch(`${base}/missing`, { headers: { origin: 'https://app.test' } });
        assert.equal(notFound.status, 404);
        assert.equal(notFound.headers.get('access-control-allow-origin'), 'https://app.test');

        const notAllowed = await fetch(`${base}/x`, { method: 'DELETE', headers: { origin: 'https://app.test' } });
        assert.equal(notAllowed.status, 405);
        assert.equal(notAllowed.headers.get('allow'), 'GET, POST');
        assert.equal(notAllowed.headers.get('access-control-allow-origin'), 'https://app.test');
    });

    it('全局中间件覆盖 404 / 405 / 命中，命中时路由级中间件仍只作用于该路由', async () => {
        seen.length = 0;
        const routed = [];
        const scoped = new Router();
        scoped.use(async (ctx, next) => { seen.push(`G ${ctx.method} ${ctx.path}`); await next(); });
        scoped.get('/hit', () => ({ ok: true }), { middleware: [async (ctx, next) => { routed.push('scoped'); await next(); }] });

        const server = HttpServer.create({
            router: scoped, serviceName: SERVICE_NAME, host: '127.0.0.1', port: 0,
            gracefulShutdown: false, logLevel: 'error',
        });
        const base = `http://127.0.0.1:${await listenHttpServer(server)}`;
        try {
            const hit = await fetch(`${base}/hit`);
            assert.deepEqual(await hit.json(), { ok: true });
            const miss = await fetch(`${base}/nope`);
            assert.equal(miss.status, 404);

            assert.deepEqual(seen, ['G GET /hit', 'G GET /nope'], '全局中间件应覆盖未命中请求');
            assert.deepEqual(routed, ['scoped'], '路由级中间件只应在命中时执行一次');
        } finally {
            await server.close();
        }
    });
});

describe('HttpServer：响应状态码日志（写出门面唯一出口）', () => {
    it('1/2/3 → INFO：文本为「客户端IP 请求方式 响应代码 原始URL status描述」', async () => {
        const logDir = mkdtempSync(join(tmpdir(), 'ysyuki-status-info-'));
        const previousDir = Logger.logDir;
        Logger.logDir = logDir;
        try {
            const base = await startServer((router) => {
                router.get('/ok', () => ({ ok: true }));
                router.get('/go', () => {
                    HttpRes.fastResRedirect('/target', 303);
                });
            }, { logLevel: 'info' });

            const entries = await captureStdoutAsync(async () => {
                const ok = await fetch(`${base}/ok?x=1`);
                assert.equal(ok.status, 200);
                await ok.text();
                const go = await fetch(`${base}/go?y=2`, { redirect: 'manual' });
                assert.equal(go.status, 303);
                await go.text();
            });

            const statuses = entries.filter((entry) => entry.fields.status !== undefined);
            assert.deepEqual(statuses.map((entry) => entry.level), ['INFO', 'INFO']);
            assert.deepEqual(statuses.map((entry) => entry.fields.status), [200, 303]);
            // 原始 URL 含查询串，不做路径归一化；status 描述取标准 reason phrase
            assert.equal(statuses[0].message, '127.0.0.1 GET 200 /ok?x=1 OK');
            assert.equal(statuses[1].message, '127.0.0.1 GET 303 /go?y=2 See Other');
            assert.equal(statuses[0].fields.service, SERVICE_NAME);
            assert.equal(statuses[0].fields.path, '/ok');
        } finally {
            Logger.logDir = previousDir;
            rmSync(logDir, { recursive: true, force: true });
        }
    });

    it('4/5 → WARN：业务直接写出的 4xx 与兜底 401/404 都记（不排除任何路径）', async () => {
        const logDir = mkdtempSync(join(tmpdir(), 'ysyuki-status-warn-'));
        const previousDir = Logger.logDir;
        Logger.logDir = logDir;
        try {
            const base = await startServer((router) => {
                router.get('/bad', () => {
                    HttpRes.jsonRes({ status: '参数错误' }, 400);
                });
                router.get('/boom', () => {
                    throw new AppError('密钥错误', 401);
                });
            }, { logLevel: 'info' });

            const entries = await captureStdoutAsync(async () => {
                const bad = await fetch(`${base}/bad`);
                assert.equal(bad.status, 400);
                await bad.text();
                const boom = await fetch(`${base}/boom`);
                assert.equal(boom.status, 401);
                await boom.text();
                const miss = await fetch(`${base}/nope`);
                assert.equal(miss.status, 404);
                await miss.text();
            });

            const statuses = entries.filter((entry) => entry.fields.status !== undefined);
            assert.deepEqual(statuses.map((entry) => entry.level), ['WARN', 'WARN', 'WARN']);
            assert.deepEqual(statuses.map((entry) => entry.fields.status), [400, 401, 404]);
            assert.equal(statuses[0].message, '127.0.0.1 GET 400 /bad Bad Request');
            assert.equal(statuses[1].message, '127.0.0.1 GET 401 /boom Unauthorized');
            assert.equal(statuses[2].message, '127.0.0.1 GET 404 /nope Not Found');
        } finally {
            Logger.logDir = previousDir;
            rmSync(logDir, { recursive: true, force: true });
        }
    });

    it('等级阈值：warn 级下 2xx 状态日志丢弃、4xx 保留', async () => {
        const logDir = mkdtempSync(join(tmpdir(), 'ysyuki-status-level-'));
        const previousDir = Logger.logDir;
        Logger.logDir = logDir;
        try {
            const base = await startServer((router) => {
                router.get('/ok', () => ({ ok: true }));
                router.get('/bad', () => {
                    HttpRes.jsonRes({ status: 'x' }, 422);
                });
            }, { logLevel: 'warn' });

            const entries = await captureStdoutAsync(async () => {
                await (await fetch(`${base}/ok`)).text();
                await (await fetch(`${base}/bad`)).text();
            });

            const statuses = entries.filter((entry) => entry.fields.status !== undefined);
            assert.deepEqual(statuses.map((entry) => entry.fields.status), [422]);
            assert.equal(statuses[0].level, 'WARN');
            assert.equal(statuses[0].message, '127.0.0.1 GET 422 /bad Unprocessable Entity');
        } finally {
            Logger.logDir = previousDir;
            rmSync(logDir, { recursive: true, force: true });
        }
    });

    it('未捕获异常：500 兜底保留原 ERROR 日志，并追加一条状态 WARN', async () => {
        const logDir = mkdtempSync(join(tmpdir(), 'ysyuki-status-crash-'));
        const previousDir = Logger.logDir;
        Logger.logDir = logDir;
        try {
            const base = await startServer((router) => {
                router.get('/crash', () => {
                    throw new Error('boom');
                });
            }, { logLevel: 'info' });

            const entries = await captureStdoutAsync(async () => {
                const res = await fetch(`${base}/crash`);
                assert.equal(res.status, 500);
                await res.text();
            });

            const errorEntry = entries.find((entry) => entry.level === 'ERROR');
            assert.ok(errorEntry !== undefined);
            assert.equal(errorEntry.message, '服务器内部错误');

            const statusEntry = entries.find((entry) => entry.fields.status === 500);
            assert.ok(statusEntry !== undefined);
            assert.equal(statusEntry.level, 'WARN');
            assert.equal(statusEntry.message, '127.0.0.1 GET 500 /crash Internal Server Error');
        } finally {
            Logger.logDir = previousDir;
            rmSync(logDir, { recursive: true, force: true });
        }
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
     * @default options = {}, configure = (router) => { ... }
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
        const port = await listenHttpServer(server);
        gracefulServers.push(server);
        return { server, base: `http://127.0.0.1:${port}` };
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
