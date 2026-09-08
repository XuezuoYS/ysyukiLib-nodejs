import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { after, afterEach, before, describe, it } from 'node:test';
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
});

describe('HttpClient：错误包装', () => {
    it('连接失败抛 HTTP Request Failed 前缀异常', async () => {
        const client = new HttpClient();
        await assert.rejects(
            () => client.get('127.0.0.1:1/unreachable'),
            (err) => err instanceof Error && err.message.startsWith('HTTP Request Failed:'),
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
