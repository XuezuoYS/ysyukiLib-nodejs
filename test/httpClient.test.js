import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { HttpClient } from '#YukiLib/httpClient';
import { Config } from '#YukiLib/config';

/**
 * 本地回显/跳转测试服务
 * @type {http.Server}
 */
let server;
/** @type {number} */
let port;

/**
 * 测试服务上"只有真被探测到才会 +1"的计数器
 *
 * 协议白名单用例的核心断言不是"抛了什么错"，而是**目标 host:port 一个请求都没收到**；
 * 光看异常的话，"先发了请求再报错"和"根本没发请求"长得一模一样。
 * @type {number}
 */
let probeHits = 0;

/**
 * 协议跳转夹具路由：pathname → 响应头 Location 原文
 *
 * `gopher:` / `file:` / `data:` 等都不得被跟随；`HTTP://…`（大写但合法的协议）
 * 是正向对照，用来证明收紧没有把正常跳转一起拦掉。`/badloc` 是解析不出来的 Location。
 *
 * @param {number} p 测试服务端口
 * @returns {Record<string, string>} 路由 → Location
 */
function redirectRoutes(p) {
    return {
        '/r-gopher': `gopher://127.0.0.1:${p}/probe-hit`,
        '/r-upper': `GOPHER://127.0.0.1:${p}/probe-hit`,
        '/r-file': 'file:///C:/Windows/win.ini',
        '/r-data': 'data:text/html,<script>alert(1)</script>',
        '/r-js': 'javascript:alert(1)',
        '/r-about': 'about:blank',
        '/r-abs-http': `HTTP://127.0.0.1:${p}/probe-hit`,
        '/badloc': 'http://[bad',
    };
}

/**
 * 本地回显/跳转测试服务基址
 * @returns {string} 基址
 */
function baseUrl() {
    return `http://127.0.0.1:${port}`;
}

before(async () => {
    server = http.createServer((req, res) => {
        /** @type {Buffer[]} */
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            const url = new URL(req.url, 'http://127.0.0.1');

            const redirect = redirectRoutes(port)[url.pathname];
            if (redirect !== undefined) {
                res.writeHead(302, { Location: redirect });
                res.end();
                return;
            }
            if (url.pathname === '/probe-hit') {
                // 只有请求**真的**被发到这个 host:port 才会走到这里
                probeHits += 1;
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('PROBE HIT');
                return;
            }
            if (url.pathname === '/echo') {
                res.writeHead(200, { 'Content-Type': 'application/json', 'X-From-Server': 'yes' });
                res.end(JSON.stringify({
                    method: req.method,
                    url: req.url,
                    body,
                    headers: req.headers,
                }));
                return;
            }
            if (url.pathname === '/r302') {
                res.writeHead(302, { Location: '/final' });
                res.end();
                return;
            }
            if (url.pathname === '/r307') {
                res.writeHead(307, { Location: '/echo' });
                res.end();
                return;
            }
            if (url.pathname === '/to-https') {
                // 跨协议重定向：指向同一端口的 https 地址（该端口实际只提供明文 HTTP）
                res.writeHead(302, { Location: `https://127.0.0.1:${port}/echo` });
                res.end();
                return;
            }
            if (url.pathname === '/loop') {
                res.writeHead(302, { Location: '/loop' });
                res.end();
                return;
            }
            if (url.pathname === '/final') {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end(`FINAL method=${req.method} referer=${req.headers.referer ?? ''}`);
                return;
            }
            if (url.pathname === '/r302big') {
                res.writeHead(302, { Location: '/big' });
                res.end();
                return;
            }
            if (url.pathname === '/big') {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('x'.repeat(64 * 1024));
                return;
            }
            if (url.pathname === '/status500') {
                res.writeHead(500);
                res.end('boom');
                return;
            }
            res.writeHead(404);
            res.end('not found');
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
});

after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await HttpClient.closeAgents();
});

describe('HttpClient：基础请求与回显', () => {
    it('GET 返回 status/headers/body/rawInfo 结构', async () => {
        const client = new HttpClient();
        const res = await client.get(`${baseUrl()}/echo?x=1`);
        assert.equal(res.status, 200);
        assert.equal(res.headers['x-from-server'], 'yes');
        const echo = JSON.parse(res.body);
        assert.equal(echo.method, 'GET');
        assert.equal(echo.url, '/echo?x=1');
        assert.equal(res.rawInfo.http_code, 200);
        assert.equal(res.rawInfo.num_redirects, 0);
    });

    it('safeUrl：无协议前缀自动补 http://', async () => {
        const client = new HttpClient();
        const res = await client.get(`127.0.0.1:${port}/echo`);
        assert.equal(res.status, 200);
    });

    it('safeUrl：非字符串入参归一化，不再抛 url.trim is not a function', async () => {
        const client = new HttpClient();

        // URL 对象（Node 里最常见的"想直接传 URL"写法）
        assert.equal(client.safeUrl(new URL(`${baseUrl()}/echo`)), `${baseUrl()}/echo`);
        assert.equal(client.safeUrl(new URL('https://example.test/a')), 'https://example.test/a');
        // 其它非字符串
        assert.equal(client.safeUrl(42), 'http://42');
        assert.equal(client.safeUrl(null), 'http://');
        assert.equal(client.safeUrl(undefined), 'http://');
        assert.equal(client.safeUrl('  '), 'http://');
        // 字符串行为不变
        assert.equal(client.safeUrl('  example.test/x  '), 'http://example.test/x');
        assert.equal(client.safeUrl('HTTPS://example.test/x'), 'HTTPS://example.test/x');

        // 端到端：直接传 URL 对象也能发请求
        const res = await client.get(new URL(`${baseUrl()}/echo`));
        assert.equal(res.status, 200);
        assert.equal(JSON.parse(res.body).url, '/echo');
    });

    it('isSSL：非字符串入参归一化', () => {
        const client = new HttpClient();
        assert.equal(client.isSSL(new URL('https://example.test/x')), true);
        assert.equal(client.isSSL(new URL('http://example.test/x')), false);
        assert.equal(client.isSSL(null), false);
    });

    it('自定义请求头与数字键原始头', async () => {
        const client = new HttpClient();
        const res = await client.get(`${baseUrl()}/echo`, { 'x-custom': 'v1' });
        assert.equal(JSON.parse(res.body).headers['x-custom'], 'v1');

        const client2 = new HttpClient();
        client2.headerAdd(['X-Raw-Line: yes']);
        const res2 = await client2.get(`${baseUrl()}/echo`);
        assert.equal(JSON.parse(res2.body).headers['x-raw-line'], 'yes');
    });

    it('请求结束后累积头被清空', async () => {
        const client = new HttpClient();
        client.headerAdd({ 'x-seen': '1' });
        await client.get(`${baseUrl()}/echo`);
        assert.deepEqual(client.headers, {});
    });

    it('POST json：对象自动序列化并带 Content-Type；form：urlencoded', async () => {
        const client = new HttpClient();
        let echo = JSON.parse((await client.post(`${baseUrl()}/echo`, { a: 1 })).body);
        assert.equal(echo.method, 'POST');
        assert.equal(echo.body, '{"a":1}');
        assert.equal(echo.headers['content-type'], 'application/json');

        const client2 = new HttpClient();
        echo = JSON.parse((await client2.post(`${baseUrl()}/echo`, { a: 1, b: 'x y' }, 'form')).body);
        assert.equal(echo.body, 'a=1&b=x+y');
        assert.equal(echo.headers['content-type'], 'application/x-www-form-urlencoded');
    });

    it('POST 字符串数据原样发送；GET 不发送请求体', async () => {
        const client = new HttpClient();
        let echo = JSON.parse((await client.requireHttp('POST', `${baseUrl()}/echo`, null, 'raw-text')).body);
        assert.equal(echo.body, 'raw-text');

        const client2 = new HttpClient();
        echo = JSON.parse((await client2.requireHttp('GET', `${baseUrl()}/echo`, null, 'ignored')).body);
        assert.equal(echo.body, '');
    });

    it('PUT/DELETE 方法透传', async () => {
        const client = new HttpClient();
        let echo = JSON.parse((await client.put(`${baseUrl()}/echo`, { u: 1 })).body);
        assert.equal(echo.method, 'PUT');
        const client2 = new HttpClient();
        echo = JSON.parse((await client2.delete(`${baseUrl()}/echo`)).body);
        assert.equal(echo.method, 'DELETE');
    });

    it('非 2xx 状态码原样返回（不抛错）', async () => {
        const client = new HttpClient();
        const res = await client.get(`${baseUrl()}/status500`);
        assert.equal(res.status, 500);
        assert.equal(res.body, 'boom');
    });
});

describe('HttpClient：同实例并发（请求头隔离）', () => {
    it('并发请求的调用方头互不污染（凭据不跨请求泄漏）', async () => {
        const client = new HttpClient();
        const [resA, resB] = await Promise.all([
            client.get(`${baseUrl()}/echo?a=1`, { 'X-Tenant': 'TENANT-A-SECRET' }),
            client.get(`${baseUrl()}/echo?b=1`, { Authorization: 'Bearer TOKEN-B' }),
        ]);
        const echoA = JSON.parse(resA.body);
        const echoB = JSON.parse(resB.body);

        assert.equal(echoA.url, '/echo?a=1');
        assert.equal(echoB.url, '/echo?b=1');
        assert.equal(echoA.headers['x-tenant'], 'TENANT-A-SECRET');
        assert.equal(echoB.headers['authorization'], 'Bearer TOKEN-B');
        // 修复前：调用方头被 headerAdd 合并回实例共享状态，后发起的请求带上了前一个请求的头
        assert.equal(echoB.headers['x-tenant'], undefined, '请求 A 的租户头泄漏到了请求 B');
        assert.equal(echoA.headers['authorization'], undefined, '请求 B 的凭据泄漏到了请求 A');
    });

    it('调用方头不写回实例累积头（请求进行中即可观测）', async () => {
        const client = new HttpClient();
        const pending = client.get(`${baseUrl()}/echo`, { 'X-Tenant': 'TENANT-A-SECRET' });
        assert.deepEqual(client.headers, {}, '调用方头被合并进了实例共享状态');
        await pending;
        assert.deepEqual(client.headers, {});
    });

    it('实例累积头作默认值：对并发每个请求都生效，且不被别的请求的头污染', async () => {
        const client = new HttpClient();
        client.headerAdd({ 'X-Common': 'shared-default' });
        const [resA, resB] = await Promise.all([
            client.get(`${baseUrl()}/echo?a=1`, { 'X-Tenant': 'A' }),
            client.get(`${baseUrl()}/echo?b=1`),
        ]);
        const headersA = JSON.parse(resA.body).headers;
        const headersB = JSON.parse(resB.body).headers;

        assert.equal(headersA['x-common'], 'shared-default');
        assert.equal(headersB['x-common'], 'shared-default');
        assert.equal(headersA['x-tenant'], 'A');
        assert.equal(headersB['x-tenant'], undefined, '并发请求 A 的私有头泄漏到了未传头的请求 B');
        assert.deepEqual(client.headers, {}, '请求结束后累积头应被清空');
    });

    it('并发 POST 的自动 Content-Type 不外溢到同实例的其它请求', async () => {
        const client = new HttpClient();
        const [resPost, resGet] = await Promise.all([
            client.post(`${baseUrl()}/echo`, { a: 1 }),
            client.get(`${baseUrl()}/echo`),
        ]);
        assert.equal(JSON.parse(resPost.body).headers['content-type'], 'application/json');
        assert.equal(JSON.parse(resGet.body).headers['content-type'], undefined,
            'POST 自动生成的 Content-Type 泄漏到了并发 GET');
    });

    it('并发 json / form：两个请求各自的 Content-Type 不串台', async () => {
        const client = new HttpClient();
        const [resJson, resForm] = await Promise.all([
            client.post(`${baseUrl()}/echo`, { a: 1 }, 'json'),
            client.post(`${baseUrl()}/echo`, { a: 1 }, 'form'),
        ]);
        const echoJson = JSON.parse(resJson.body);
        const echoForm = JSON.parse(resForm.body);
        assert.equal(echoJson.headers['content-type'], 'application/json');
        assert.equal(echoJson.body, '{"a":1}');
        assert.equal(echoForm.headers['content-type'], 'application/x-www-form-urlencoded');
        assert.equal(echoForm.body, 'a=1');
    });

    it('调用方显式 Content-Type 优先于 dataType 自动值（对象头 / 原始行头）', async () => {
        const client = new HttpClient();
        let res = await client.post(`${baseUrl()}/echo`, { a: 1 }, 'json', { 'content-type': 'text/csv' });
        assert.equal(JSON.parse(res.body).headers['content-type'], 'text/csv');

        const client2 = new HttpClient();
        res = await client2.post(`${baseUrl()}/echo`, { a: 1 }, 'form', ['Content-Type: application/octet-stream']);
        assert.equal(JSON.parse(res.body).headers['content-type'], 'application/octet-stream');
    });

    it('并发重定向：每条链的 Referer 只属于自己的上一跳', async () => {
        const client = new HttpClient();
        const [resA, resB] = await Promise.all([
            client.get(`${baseUrl()}/r302?chain=a`),
            client.get(`${baseUrl()}/r302?chain=b`),
        ]);
        assert.ok(resA.body.includes(`referer=${baseUrl()}/r302?chain=a`), resA.body);
        assert.ok(resB.body.includes(`referer=${baseUrl()}/r302?chain=b`), resB.body);
    });

    it('高并发 8 路：每个请求只带自己的头与自己的路径', async () => {
        const client = new HttpClient();
        const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
            client.get(`${baseUrl()}/echo?i=${i}`, { 'X-Case': `case-${i}`, Authorization: `Bearer t-${i}` })));

        results.forEach((res, i) => {
            const echo = JSON.parse(res.body);
            assert.equal(echo.url, `/echo?i=${i}`);
            assert.equal(echo.headers['x-case'], `case-${i}`);
            assert.equal(echo.headers['authorization'], `Bearer t-${i}`);
            for (let j = 0; j < 8; j += 1) {
                if (j === i) {
                    continue;
                }
                assert.notEqual(echo.headers['x-case'], `case-${j}`, `请求 ${i} 带上了请求 ${j} 的头`);
            }
        });
        assert.deepEqual(client.headers, {});
    });
});

describe('HttpClient：重定向', () => {
    it('302 自动跳转：POST 降级为 GET 且自动 Referer', async () => {
        const client = new HttpClient();
        const res = await client.post(`${baseUrl()}/r302`, { a: 1 });
        assert.equal(res.status, 200);
        assert.ok(res.body.startsWith('FINAL method=GET'));
        assert.ok(res.body.includes(`referer=${baseUrl()}/r302`));
        assert.equal(res.rawInfo.num_redirects, 1);
        assert.equal(res.rawInfo.url, `${baseUrl()}/final`);
    });

    it('307 保持方法与请求体', async () => {
        const client = new HttpClient();
        const res = await client.post(`${baseUrl()}/r307`, { a: 1 });
        const echo = JSON.parse(res.body);
        assert.equal(echo.method, 'POST');
        assert.equal(echo.body, '{"a":1}');
    });

    it('重定向上限 10 次：超限返回最后一个 3xx 响应', async () => {
        const client = new HttpClient();
        const res = await client.get(`${baseUrl()}/loop`);
        assert.equal(res.status, 302);
        assert.equal(res.rawInfo.num_redirects, 10);
    });

    it('跨协议重定向：按目标 URL 的协议发送（http→https 走 TLS 而非明文）', async () => {
        const client = new HttpClient();
        // 目标被当作 HTTPS 处理：对只提供明文 HTTP 的端口做 TLS 握手，必然失败；
        // 若仍沿用初始 http 判定，则会拿到 200，本用例即失败
        await assert.rejects(
            () => client.get(`${baseUrl()}/to-https`),
            (err) => err instanceof Error && err.message.startsWith('HTTP Request Failed:'),
        );
        assert.equal(client.ssl, true);
    });

    it('跨协议 http→https 仍算合法跳转（白名单不收掉 https）', async () => {
        const client = new HttpClient();
        await assert.rejects(
            () => client.get(`${baseUrl()}/to-https`),
            (err) => err instanceof Error
                && !/重定向目标协议不在允许列表内/.test(err.message)
                && !/不支持的请求协议/.test(err.message),
            'https: 跳转被误当成不受支持协议拦下',
        );
    });
});

describe('HttpClient：重定向协议白名单', () => {
    beforeEach(() => {
        probeHits = 0;
        HttpClient.allowedRedirectProtocols = null;
    });
    afterEach(() => {
        HttpClient.allowedRedirectProtocols = null;
    });

    it('gopher:// 跳转被拒绝，且目标 host:port 一个请求都没收到', async () => {
        // 修复前：Location 被强制当成明文 HTTP 发出，本用例直接拿到 200 "PROBE HIT"
        await assert.rejects(
            () => new HttpClient().get(`${baseUrl()}/r-gopher`),
            (err) => err instanceof Error
                && err.message.startsWith('HTTP Request Failed: ')
                && err.message.includes('重定向目标协议不在允许列表内：gopher:'),
        );
        assert.equal(probeHits, 0, '被拒绝的跳转仍然发出了请求（任意 host:port 探测面未关闭）');
    });

    it('协议大小写不影响判定（GOPHER:// 同样被拒）', async () => {
        await assert.rejects(
            () => new HttpClient().get(`${baseUrl()}/r-upper`),
            (err) => err instanceof Error && err.message.includes('gopher:'),
        );
        assert.equal(probeHits, 0);
    });

    it('file: / data: / javascript: / about: 一律不跟随，且异常原因不为空', async () => {
        for (const [path, protocol] of [
            ['/r-file', 'file:'], ['/r-data', 'data:'], ['/r-js', 'javascript:'], ['/r-about', 'about:'],
        ]) {
            await assert.rejects(
                () => new HttpClient().get(`${baseUrl()}${path}`),
                (err) => err instanceof Error
                    && err.message.startsWith('HTTP Request Failed: ')
                    // 修复前这两条路都落在 node 的空 message AggregateError 上，尾巴是空的
                    && err.message.slice('HTTP Request Failed: '.length).trim() !== ''
                    && err.message.includes(protocol),
                `${path} 应被拒绝且给出非空原因`,
            );
            assert.equal(probeHits, 0, `${path} 被跟随了`);
        }
    });

    it('正向对照：大小写与绝对 URL 都不影响合法跳转', async () => {
        const res = await new HttpClient().get(`${baseUrl()}/r-abs-http`);
        assert.equal(res.status, 200);
        assert.equal(res.body, 'PROBE HIT');
        assert.equal(res.rawInfo.num_redirects, 1);
        assert.equal(res.rawInfo.url, `${baseUrl()}/probe-hit`);
        assert.equal(probeHits, 1);
    });

    it('拒绝时只回显协议名，不回显 Location 原文', async () => {
        // 错误信息通常被宿主写进共享日志，Location 里可能带签名令牌或敏感路径
        await assert.rejects(
            () => new HttpClient().get(`${baseUrl()}/r-gopher`),
            (err) => err instanceof Error && !err.message.includes('probe-hit'),
        );
    });

    it('Location 解析失败仍是显式失败（不静默当成"没有跳转"）', async () => {
        await assert.rejects(
            () => new HttpClient().get(`${baseUrl()}/badloc`),
            (err) => err instanceof Error && err.message === 'HTTP Request Failed: Invalid URL',
        );
    });

    it('白名单可配置：归一化写法、可收窄、[] 表示不跟随任何跳转', async () => {
        HttpClient.allowedRedirectProtocols = ['https'];
        assert.deepEqual(HttpClient.allowedRedirectProtocols, ['https:']);
        await assert.rejects(
            () => new HttpClient().get(`${baseUrl()}/r302`),
            (err) => err instanceof Error && err.message.includes('当前允许：https:'),
        );

        HttpClient.allowedRedirectProtocols = 'http, https';
        assert.deepEqual(HttpClient.allowedRedirectProtocols, ['http:', 'https:']);
        assert.equal((await new HttpClient().get(`${baseUrl()}/r302`)).status, 200);

        HttpClient.allowedRedirectProtocols = new Set(['HTTPS://', 'https:']);
        assert.deepEqual(HttpClient.allowedRedirectProtocols, ['https:'], '应归一化并去重');

        HttpClient.allowedRedirectProtocols = [];
        await assert.rejects(
            () => new HttpClient().get(`${baseUrl()}/r302`),
            (err) => err instanceof Error && err.message.includes('当前允许：无'),
        );

        HttpClient.allowedRedirectProtocols = null;
        assert.deepEqual(HttpClient.allowedRedirectProtocols, ['http:', 'https:']);
    });

    it('只能收窄不能放宽：非法项抛错且不改动生效值', async () => {
        for (const bad of [['http:', 'gopher:'], ['ftp://'], ['file'], [''], ['ht tp']]) {
            assert.throws(
                () => {
                    HttpClient.allowedRedirectProtocols = bad;
                },
                /仅支持 http: \/ https:/,
                `${JSON.stringify(bad)} 应被拒绝`,
            );
            assert.deepEqual(
                HttpClient.allowedRedirectProtocols, ['http:', 'https:'],
                `${JSON.stringify(bad)} 被拒后生效白名单不应改变`,
            );
        }
        // 空串整体：分隔后只剩空项，同样按非法处理（不能让手滑静默变成"允许空协议"）
        assert.throws(() => {
            HttpClient.allowedRedirectProtocols = '';
        }, /仅支持 http: \/ https:/);
        assert.throws(() => {
            HttpClient.allowedRedirectProtocols = /** @type {any} */ (42);
        }, /需为字符串数组、Set 或逗号\/空白分隔的字符串/);
        assert.deepEqual(HttpClient.allowedRedirectProtocols, ['http:', 'https:']);
    });

    it('getter 返回副本：改返回值不影响生效白名单', async () => {
        const list = HttpClient.allowedRedirectProtocols;
        list.push('ftp:', 'gopher:');
        assert.deepEqual(HttpClient.allowedRedirectProtocols, ['http:', 'https:']);
        assert.equal(probeHits, 0);
        assert.equal((await new HttpClient().get(`${baseUrl()}/r302`)).status, 200);
    });

    it('白名单只作用于跳转，不作用于初始 URL', async () => {
        HttpClient.allowedRedirectProtocols = ['https:'];
        const res = await new HttpClient().get(`${baseUrl()}/echo`);
        assert.equal(res.status, 200, '仅允许 https 的白名单不应拦掉显式发起的明文请求');
    });

    it('被拒后实例状态干净：累积头已清空、同实例后续请求照常', async () => {
        const client = new HttpClient();
        client.headerAdd({ 'X-Case': 'hygiene' });
        await assert.rejects(() => client.get(`${baseUrl()}/r-gopher`), /重定向目标协议不在允许列表内/);
        assert.deepEqual(client.headers, {});
        assert.equal(probeHits, 0);

        const res = await client.get(`${baseUrl()}/r302`);
        assert.equal(res.status, 200);
        assert.ok(res.body.startsWith('FINAL method=GET'), res.body);
    });
});

describe('HttpClient：错误包装', () => {
    it('连接失败抛 HTTP Request Failed 前缀异常', async () => {
        const client = new HttpClient();
        await assert.rejects(
            () => client.get('127.0.0.1:1/unreachable'),
            (err) => err instanceof Error && err.message.startsWith('HTTP Request Failed:'),
        );
    });

    it('多地址连接失败（底层 message 为空）也能给出非空原因', async () => {
        // localhost 同时解析出 ::1 与 127.0.0.1，两个地址都被拒时 node 抛 happy-eyeballs 的
        // AggregateError：message 是**空串**，信息只在 code / errors[] 里。
        // 修复前这里只剩 "HTTP Request Failed: "（后无内容），且 file:// 之类的跳转
        // 正是退化成连 localhost:80 后撞上这条路径。
        const client = new HttpClient();
        await assert.rejects(
            () => client.get('http://localhost:1/multi-address'),
            (err) => {
                assert.ok(err instanceof Error);
                assert.ok(err.message.startsWith('HTTP Request Failed: '), err.message);
                assert.notEqual(err.message.slice('HTTP Request Failed: '.length).trim(), '', '原因不能为空');
                assert.match(err.message, /ECONNREFUSED/);
                const cause = /** @type {any} */ (err.cause);
                assert.equal(cause.code, 'ECONNREFUSED', '原始异常仍在 cause 上');
                if (cause.message.trim() === '') {
                    // 空 message 的 AggregateError：原因必须由 code / errors[] 补出来
                    assert.ok(Array.isArray(cause.errors));
                    assert.ok(cause.errors.length > 1, '本用例需要真正走到多地址聚合失败');
                    assert.ok(err.message.includes(String(cause.errors[0].message)), err.message);
                }
                return true;
            },
        );
    });

    it('异常原因取自底层错误：单地址失败保持原有 message（不夹带 Location 等原文）', async () => {
        const client = new HttpClient();
        await assert.rejects(
            () => client.get('http://127.0.0.1:1/single-address'),
            (err) => err instanceof Error
                && /^HTTP Request Failed: connect ECONNREFUSED 127\.0\.0\.1:1$/.test(err.message)
                && err.cause instanceof Error
                && /** @type {any} */ (err.cause).code === 'ECONNREFUSED',
        );
    });
});

describe('HttpClient：SSL 状态', () => {
    it('isSSL：按协议返回，并把结果写回实例状态（http 复位为 false）', () => {
        const client = new HttpClient();
        assert.equal(client.isSSL('https://example.test/x'), true);
        assert.equal(client.ssl, true);
        assert.equal(client.isSSL('http://example.test/x'), false);
        assert.equal(client.ssl, false);
    });

    it('同一实例先 https 后 http：第二次仍按明文发送，SSL 状态不粘滞', async () => {
        const client = new HttpClient();
        await assert.rejects(
            () => client.get('https://127.0.0.1:1/ssl-probe'),
            (err) => err instanceof Error && err.message.startsWith('HTTP Request Failed:'),
        );
        assert.equal(client.ssl, true);

        const res = await client.get(`${baseUrl()}/echo`);
        assert.equal(res.status, 200);
        assert.equal(JSON.parse(res.body).method, 'GET');
        assert.equal(client.ssl, false);
    });
});

describe('HttpClient：响应体大小上限', () => {
    afterEach(() => {
        HttpClient.maxBodyMb = 0;
    });

    it('默认 0：不限制响应体大小', async () => {
        const res = await new HttpClient().get(`${baseUrl()}/big`);
        assert.equal(res.status, 200);
        assert.equal(res.body.length, 64 * 1024);
    });

    it('设置上限：超出时抛 HTTP Request Failed: 响应体过大（上限 N MB）', async () => {
        HttpClient.maxBodyMb = 0.001; // 1 KB
        await assert.rejects(
            () => new HttpClient().get(`${baseUrl()}/big`),
            (err) => err instanceof Error
                && err.message.startsWith('HTTP Request Failed:')
                && err.message.includes('响应体过大')
                && err.message.includes('上限 0.001 MB'),
        );
    });

    it('设置上限：未超出时正常返回', async () => {
        HttpClient.maxBodyMb = 1;
        const res = await new HttpClient().get(`${baseUrl()}/final`);
        assert.equal(res.status, 200);
        assert.ok(res.body.startsWith('FINAL method=GET'));
    });

    it('非法值（负数 / NaN）按无限制处理', async () => {
        for (const value of [-1, NaN]) {
            HttpClient.maxBodyMb = value;
            const res = await new HttpClient().get(`${baseUrl()}/big`);
            assert.equal(res.status, 200, `maxBodyMb=${value} 应视为无限制`);
            assert.equal(res.body.length, 64 * 1024);
        }
    });

    it('重定向后的响应同样受上限约束（按每一跳各自适用）', async () => {
        HttpClient.maxBodyMb = 0.001; // 1 KB
        await assert.rejects(
            () => new HttpClient().get(`${baseUrl()}/r302big`),
            (err) => err instanceof Error
                && err.message.startsWith('HTTP Request Failed:')
                && err.message.includes('响应体过大'),
        );
    });
});

describe('HttpClient：自定义 CA', () => {
    /**
     * 抓取下一次 HTTPS 请求实际使用的 Agent
     *
     * 通过临时替换 https.request 读取 options.agent，避免依赖库内部实现细节。
     *
     * @param {() => Promise<any>} fn 触发请求的异步函数
     * @returns {Promise<any>} 该请求使用的 agent
     */
    async function captureAgent(fn) {
        const original = https.request;
        /** @type {any} */
        let captured;
        https.request = function patched(options, ...rest) {
            captured = options.agent;
            return original.call(this, options, ...rest);
        };
        try {
            await fn();
        } finally {
            https.request = original;
        }
        return captured;
    }

    it('caFilePath：默认为宿主根下 CA/cacert.pem，可显式重定向', () => {
        const root = Config.getRootDir();
        assert.equal(HttpClient.caFilePath, Config.resolveFromRoot('CA', 'cacert.pem'));
        HttpClient.caFilePath = join(root, 'CA', 'other.pem');
        try {
            assert.equal(HttpClient.caFilePath, join(root, 'CA', 'other.pem'));
        } finally {
            HttpClient.caFilePath = null;
        }
        assert.equal(HttpClient.caFilePath, Config.resolveFromRoot('CA', 'cacert.pem'));
    });

    it('改 caFilePath 即重建 HTTPS Agent，无需手动 closeAgents', async () => {
        const caDir = mkdtempSync(join(tmpdir(), 'ysyuki-ca-'));
        const pemA = join(caDir, 'a.pem');
        const pemB = join(caDir, 'b.pem');
        writeFileSync(pemA, '-----BEGIN CERTIFICATE-----\nA\n-----END CERTIFICATE-----\n', 'utf8');
        writeFileSync(pemB, '-----BEGIN CERTIFICATE-----\nB\n-----END CERTIFICATE-----\n', 'utf8');

        const client = new HttpClient();
        try {
            HttpClient.caFilePath = pemA;
            // 首次请求按 a.pem 建立 Agent（证书内容非法也无妨，请求本就失败）
            const agentA = await captureAgent(() => assert.rejects(() => client.get('https://127.0.0.1:1/ca-a'), /HTTP Request Failed/));
            assert.ok(agentA, '应捕获到 HTTPS Agent');

            HttpClient.caFilePath = pemB; // 修复前：缓存命中旧路径，仍沿用 a.pem 的 Agent
            const agentB = await captureAgent(() => assert.rejects(() => client.get('https://127.0.0.1:1/ca-b'), /HTTP Request Failed/));

            assert.notEqual(agentB, agentA, '换 CA 路径后应重建 Agent');
        } finally {
            HttpClient.caFilePath = null;
            HttpClient.closeAgents();
            rmSync(caDir, { recursive: true, force: true });
        }
    });

    it('同一路径下替换证书内容：需 closeAgents() 才会重新读取', async () => {
        const caDir = mkdtempSync(join(tmpdir(), 'ysyuki-ca-same-'));
        const pem = join(caDir, 'same.pem');
        writeFileSync(pem, '-----BEGIN CERTIFICATE-----\nOLD\n-----END CERTIFICATE-----\n', 'utf8');

        const client = new HttpClient();
        try {
            HttpClient.caFilePath = pem;
            const before = await captureAgent(() => assert.rejects(() => client.get('https://127.0.0.1:1/same-a'), /HTTP Request Failed/));

            writeFileSync(pem, '-----BEGIN CERTIFICATE-----\nNEW\n-----END CERTIFICATE-----\n', 'utf8');
            const unchanged = await captureAgent(() => assert.rejects(() => client.get('https://127.0.0.1:1/same-b'), /HTTP Request Failed/));
            assert.equal(unchanged, before, '路径未变时复用 Agent（不重新读文件）');

            HttpClient.closeAgents();
            const afterClose = await captureAgent(() => assert.rejects(() => client.get('https://127.0.0.1:1/same-c'), /HTTP Request Failed/));
            assert.notEqual(afterClose, before, 'closeAgents 后按同一路径重新读取并重建');
        } finally {
            HttpClient.caFilePath = null;
            HttpClient.closeAgents();
            rmSync(caDir, { recursive: true, force: true });
        }
    });

    it('宿主根无 CA 文件时回退系统 CA：不因证书文件缺失而抛 ENOENT', async () => {
        const emptyRoot = mkdtempSync(join(tmpdir(), 'ysyuki-noca-'));
        const rootBefore = Config.getRootDir();
        // 重置 HTTPS Agent 与 CA 缓存，使新的宿主根重新解析 CA
        HttpClient.closeAgents();
        Config.setRootDir(emptyRoot);
        try {
            const client = new HttpClient();
            await assert.rejects(
                () => client.get('https://127.0.0.1:1/noca'),
                (err) => err instanceof Error
                    && err.message.startsWith('HTTP Request Failed:')
                    && !err.message.includes('ENOENT')
                    && !err.message.includes('cacert'),
            );
        } finally {
            Config.setRootDir(rootBefore);
            HttpClient.closeAgents();
            rmSync(emptyRoot, { recursive: true, force: true });
        }
    });
});
