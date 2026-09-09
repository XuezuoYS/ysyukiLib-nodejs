/**
 * fetch 可用端口夹具：让测试服务落在 `fetch()` 不会拒绝的端口上
 *
 * 背景：用例普遍用 `listen(0)` 让系统分配端口，再用全局 `fetch()` 打真实请求。
 * 而 WHATWG Fetch 规范带有一份 **port block list**，`fetch()` 在建立连接之前就会按它拒绝
 * （undici 报 `TypeError: fetch failed`，`cause.message === 'bad port'`）。这份清单里的
 * `1719 / 2049 / 3659 / 4045 / 5060 / 5061 / 6000 / 6566 / 6665–6669 / 6697 / 10080`
 * 都落在 Windows 的临时端口区间内（本机 `netsh int ipv4 show dynamicport tcp` 实测
 * 起始 1024、共 13977 个），于是系统偶尔把禁端口分给测试服务——表现为
 * `server.test.js` 随机红掉一两个用例（同一份代码连跑 6 次约中 1 次，且每次红的用例不同）。
 *
 * 这与被测库无关：只有走全局 `fetch()` 的用例受影响，`http.request`（`getOrHang`）与
 * `HttpClient`（`node:https`）都不查这份清单。故只在测试夹具里避开，不改任何产品代码。
 */

/**
 * WHATWG Fetch 的 port block list（规范同名的那份清单）
 *
 * 有意取规范完整清单，比本机实现更宽：个别条目当前 undici 版本并不拦截
 * （实测 527 / 528 / 529 / 4043），多避开几个端口只是偶尔多一次重听；
 * 反过来漏掉条目才会让用例随机红。清单是否仍然成立由
 * `fetchPortFixture.test.js` 的「前提成立」用例贴着真实 `fetch()` 锁住。
 * @type {ReadonlySet<number>}
 */
export const FETCH_BLOCKED_PORTS = new Set([
    1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
    101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179,
    389, 427, 465, 512, 513, 514, 515, 526, 527, 528, 529, 548, 554, 556, 563, 587, 601, 636,
    989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4043, 4045, 5060, 5061, 6000, 6566,
    6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);

/**
 * 该端口是否会被 `fetch()` 直接拒掉
 *
 * @param {number} port 端口
 * @returns {boolean} 被禁返回 true
 */
export function isFetchBlockedPort(port) {
    return FETCH_BLOCKED_PORTS.has(port);
}

/**
 * 启动监听并确保端口可被 `fetch()` 使用
 *
 * 抽中禁端口时关闭并重新 `listen(0)`：系统的分配计数器会向前走，一两轮即可越过去；
 * 换用固定端口反而会带来占用与并行冲突，这里刻意不这么做。
 *
 * @param {() => Promise<number>} start 启动监听（端口传 0 由系统分配），返回实际端口
 * @param {(port: number) => Promise<void>} stop 关闭该端口的监听
 * @param {number} [attempts] 重试上限
 * @default attempts = 20
 * @returns {Promise<number>} 可被 fetch 使用的端口
 * @throws {Error} 连续抽中禁端口（正常环境不会发生，报错含最后一次端口便于排查）
 */
export async function listenOnFetchablePort(start, stop, attempts = 20) {
    /** @type {number|null} */
    let last = null;
    for (let i = 0; i < attempts; i += 1) {
        last = await start();
        if (!isFetchBlockedPort(last)) {
            return last;
        }
        await stop(last);
    }
    throw new Error(`连续 ${attempts} 次拿到 fetch 禁端口（最后一次：${last}）`);
}
