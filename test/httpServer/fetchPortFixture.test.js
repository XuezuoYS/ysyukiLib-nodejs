import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Config } from '#YukiLib/config';
import { HttpServer, Router } from '#YukiLib/httpServer';
import { Logger } from '#YukiLib/logger';

import { FETCH_BLOCKED_PORTS, isFetchBlockedPort, listenOnFetchablePort } from './fetchPortFixture.js';

/**
 * fetch 端口夹具自检
 *
 * 这层夹具的存在意义就是"让随机红变成不红"。它自己退化成空转（清单被清空、重试分支不再关闭）时，
 * 真实用例只会偶尔红一次且每次红在不同地方，很难归因，故单独锁住——含一条真实监听往返。
 */

describe('fetchPortFixture：fetch 禁端口清单', () => {
    it('覆盖落在本机临时端口区间内的已知禁端口', () => {
        // 本机 Windows 临时端口区间实测为起始 1024、共 13977 个；下列端口实测均被 fetch
        // 在建连前拒绝（cause.message === 'bad port'），因此 listen(0) 真的可能分到它们
        for (const port of [1719, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6669, 6697, 10080]) {
            assert.ok(isFetchBlockedPort(port), `${port} 应在 WHATWG port block list 内`);
        }
        assert.ok(FETCH_BLOCKED_PORTS.size > 50, '清单不应被清空（清空即等于没修）');
    });

    it('常用高位端口不被判定为禁端口', () => {
        for (const port of [1025, 3000, 8080, 10000, 12345, 2048, 4044, 4046, 10079, 10081]) {
            assert.ok(!isFetchBlockedPort(port), `${port} 不该被误判`);
        }
    });
});

describe('fetchPortFixture：抽中禁端口时重新监听', () => {
    it('逐个关闭被拒端口，直到拿到可用端口', async () => {
        const assigned = [6667, 4045, 13456];
        /** @type {number[]} */
        const closed = [];
        let i = 0;
        const port = await listenOnFetchablePort(
            async () => assigned[i++],
            async (rejected) => {
                closed.push(rejected);
            },
        );
        assert.equal(port, 13456);
        assert.deepEqual(closed, [6667, 4045], '每个被拒端口都应先被关闭');
    });

    it('首次即可用时不关闭任何东西、不多听一次', async () => {
        /** @type {number[]} */
        const closed = [];
        let starts = 0;
        const port = await listenOnFetchablePort(
            async () => {
                starts += 1;
                return 14000;
            },
            async (rejected) => {
                closed.push(rejected);
            },
        );
        assert.equal(port, 14000);
        assert.equal(starts, 1);
        assert.deepEqual(closed, []);
    });

    it('连续抽中禁端口时明确报错，而不是无限重试', async () => {
        let starts = 0;
        await assert.rejects(
            listenOnFetchablePort(
                async () => {
                    starts += 1;
                    return 6666;
                },
                async () => undefined,
                3,
            ),
            /连续 3 次拿到 fetch 禁端口（最后一次：6666）/,
        );
        assert.equal(starts, 3, '报错前应把重试次数用满');
    });
});

describe('fetchPortFixture：前提成立（本机 fetch 真的拒绝清单内端口）', () => {
    it('fetch 到清单内端口时在建连前就失败（cause 为端口被拒）', async () => {
        // 锁住夹具的前提。若本条失败并显示"未被拒绝"，说明当前 Node/undici 不再查这份清单，
        // 夹具退化为多余但无害（顶多多避开几个端口）；此时可整体删掉 fetchPortFixture 与本用例。
        /** @type {{ cause?: { message?: string } } | null} */
        let failure = null;
        try {
            await fetch('http://127.0.0.1:6667/probe'); // 清单内端口，不要求有人监听
            throw new Error('fetch 竟然成功了：该端口未被拒绝');
        } catch (/** @type {any} */ err) {
            failure = err;
        }
        assert.equal(
            failure?.cause?.message,
            'bad port',
            `本机 fetch 未拒绝清单内端口（cause: ${failure?.cause?.message}），夹具前提已变化`,
        );
    });
});

describe('fetchPortFixture：与真实 HttpServer 配合', () => {    /** 宿主根与日志目录都落在临时目录，不依赖也不写入库自身目录 */
    const dir = mkdtempSync(join(tmpdir(), 'ysyuki-fetch-port-'));
    Config.setRootDir(dir);
    Logger.logDir = join(dir, 'log');

    after(() => {
        Logger.logDir = null;
        Config.setRootDir(null);
        rmSync(dir, { recursive: true, force: true });
    });

    it('被拒端口关闭后能重新监听，交回的端口真的响应 fetch', async () => {
        const router = new Router();
        router.get('/ping', () => ({ ok: true }));
        const server = HttpServer.create({
            router,
            host: '127.0.0.1',
            port: 0,
            gracefulShutdown: false,
            exitOnShutdown: false,
        });

        let first = true;
        const port = await listenOnFetchablePort(
            async () => {
                await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
                if (first) {
                    first = false;
                    return 6667; // 伪装成"系统分到了禁端口"，逼出关闭-重听这条真实分支
                }
                return server.port;
            },
            async () => server.close(),
        );

        try {
            assert.ok(!isFetchBlockedPort(port));
            const res = await fetch(`http://127.0.0.1:${port}/ping`);
            assert.equal(res.status, 200, '重听后的端口必须真的可用');
            assert.deepEqual(await res.json(), { ok: true });
        } finally {
            await server.close();
        }
    });
});
