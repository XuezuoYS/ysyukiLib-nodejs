/**
 * 安装态冒烟：站在**宿主项目**视角验证"装上就能用"，与库内单测互补。
 *
 * 由 CI 复制到临时消费者目录（`ci/consumer/package.json` 的旁边）后执行，
 * 因此本文件所在目录的 `package.json` 里带着宿主侧 `imports` 别名
 * `"#YukiLib/*": "ysyuki-lib-on-nodejs/*"` —— 这正是 README「接入」承诺的写法，
 * 库内测试只能证明库自己能用别名，安装态必须另外验。
 *
 * 覆盖四件事：
 * 1. `exports` 各级子路径可解析，且与包名根入口指向**同一实现**（对象同一性）；
 * 2. 宿主侧 `#YukiLib/*` 别名可用；
 * 3. 包边界：`files` 生效，运行期需要的 `src/` 在包里，`.git` / `node_modules` 不在；
 * 4. 装完的最小行为可用：Router 模板匹配（含 `{id:int}` 转 number）与 FuncResult。
 *
 * 用法：`node smoke.mjs --source tarball|git-url [--expect-version 0.1.0] [--spec <安装串>]`
 *
 * 注意：本脚本不实例化 Logger / HttpServer / HttpClient，不写日志目录、不开端口，
 * 保证在任何干净消费者目录里都不产生副作用。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** 包根入口应导出的全部类（README「模块」表与 src/index.js 的契约） */
const EXPECTED_EXPORTS = Object.freeze([
    'AppError',
    'Config',
    'FuncResult',
    'HttpClient',
    'HttpReq',
    'HttpServer',
    'HttpRes',
    'Logger',
    'Middleware',
    'Router',
    'ServerLogger',
]);

/** 绝不允许出现在已安装包里的东西（装了源码树以外的东西 = 打包边界失守） */
const NEVER_PRESENT = Object.freeze(['.git', 'node_modules']);

const { values: options } = parseArgs({
    options: {
        source: { type: 'string' },
        'expect-version': { type: 'string' },
        spec: { type: 'string' },
    },
    strict: true,
});

/** @type {string[]} */
const failures = [];
let checks = 0;

/**
 * 执行一条断言并记账
 *
 * @param {string} label 用例名
 * @param {() => void | Promise<void>} fn 断言体，抛错即失败
 * @returns {Promise<void>}
 */
async function check(label, fn) {
    checks += 1;
    try {
        await fn();
        process.stdout.write(`  ✔ ${label}\n`);
    } catch (error) {
        failures.push(`${label}：${(error && error.message) || error}`);
        process.stdout.write(`  ✖ ${label}\n    ${(error && error.message) || error}\n`);
    }
}

/**
 * 动态导入，失败时把说明符带进错误信息（否则只有一串 ERR_MODULE_NOT_FOUND）
 *
 * @param {string} specifier 模块说明符
 * @returns {Promise<any>} 模块命名空间
 */
async function importSpec(specifier) {
    try {
        return await import(specifier);
    } catch (error) {
        throw new Error(`导入 "${specifier}" 失败：${(error && error.message) || error}`);
    }
}

process.stdout.write(`安装态冒烟（来源：${options.source ?? 'unknown'}${options.spec ? ` · ${options.spec}` : ''}）\n`);

/** @type {any} */
let pkgRoot;
/** @type {any} */
let serverBarrel;
/** @type {any} */
let deepRouter;
/** @type {any} */
let aliasConfig;
/** @type {any} */
let aliasServerBarrel;

// —— 1. 解析与同一性 ————————————————————————————————————————————————
process.stdout.write('模块解析：\n');

for (const specifier of ['ysyuki-lib-on-nodejs', 'ysyuki-lib-on-nodejs/httpServer', 'ysyuki-lib-on-nodejs/httpServer/router', '#YukiLib/config', '#YukiLib/httpServer']) {
    await check(`可解析 ${specifier}`, async () => {
        await importSpec(specifier);
    });
}

pkgRoot = await importSpec('ysyuki-lib-on-nodejs').catch(() => ({}));
serverBarrel = await importSpec('ysyuki-lib-on-nodejs/httpServer').catch(() => ({}));
deepRouter = await importSpec('ysyuki-lib-on-nodejs/httpServer/router').catch(() => ({}));
aliasConfig = await importSpec('#YukiLib/config').catch(() => ({}));
aliasServerBarrel = await importSpec('#YukiLib/httpServer').catch(() => ({}));

await check(`包根导出齐全（${EXPECTED_EXPORTS.length} 个类）`, () => {
    assert.ok(pkgRoot, '包根导入失败');
    for (const name of EXPECTED_EXPORTS) {
        assert.equal(typeof pkgRoot[name], 'function', `缺少导出 ${name}`);
    }
    const extra = Object.keys(pkgRoot).filter((key) => !EXPECTED_EXPORTS.includes(key));
    if (extra.length > 0) {
        process.stdout.write(`  ℹ 包根另有导出：${extra.join(', ')}（README「模块」表需同步）\n`);
    }
});

await check('子域 barrel 导出 httpServer 全家', () => {
    for (const name of ['AppError', 'HttpReq', 'HttpServer', 'HttpRes', 'Middleware', 'Router', 'ServerLogger', 'encodeUrlParam', 'HTTP_METHODS']) {
        assert.ok(name in serverBarrel, `httpServer barrel 缺少 ${name}`);
    }
});

await check('深子路径可解析（exports 的 ./* 通配）', () => {
    assert.equal(typeof deepRouter.Router, 'function');
});

// —— 2. 同一实现（三处入口 + 宿主别名） ——————————————————————————————
process.stdout.write('同一实现：\n');

await check('包根 === 子域 barrel === 深子路径 === 宿主别名', () => {
    assert.equal(pkgRoot.Router, serverBarrel.Router, '包根与 /httpServer 的 Router 不是同一实现');
    assert.equal(pkgRoot.Router, deepRouter.Router, '/httpServer 与 /httpServer/router 的 Router 不是同一实现');
    assert.equal(pkgRoot.Router, aliasServerBarrel.Router, '宿主 #YukiLib/httpServer 别名与包名子路径不是同一实现');
    assert.equal(pkgRoot.Config, aliasConfig.Config, '宿主 #YukiLib/config 别名与包名子路径不是同一实现');
});

// —— 3. 包边界与清单 ————————————————————————————————————————————————
process.stdout.write('包边界：\n');

/** @type {string} */
let packageDir = '';
/** @type {any} */
let manifest = {};

await check('可定位已安装包目录并读到 package.json', () => {
    const manifestUrl = import.meta.resolve('ysyuki-lib-on-nodejs/package.json');
    packageDir = path.dirname(fileURLToPath(manifestUrl));
    manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    assert.equal(manifest.name, 'ysyuki-lib-on-nodejs');
});

await check('version 与期望一致', () => {
    const expectVersion = options['expect-version'];
    if (expectVersion === undefined) {
        return;
    }
    assert.equal(manifest.version, expectVersion, '装到的 package.json version 与 tag 不一致');
});

await check('src/index.js 在包内', () => {
    assert.ok(fs.existsSync(path.join(packageDir, 'src', 'index.js')), `缺少 src/index.js（${packageDir}）`);
});

await check(`${NEVER_PRESENT.join(' / ')} 不在包内`, () => {
    for (const entry of NEVER_PRESENT) {
        assert.ok(!fs.existsSync(path.join(packageDir, entry)), `包内出现 ${entry}`);
    }
});

await check('零第三方运行时依赖（README 的核心承诺）', () => {
    assert.deepEqual(manifest.dependencies ?? {}, {}, '出现 dependencies，与"零运行时依赖"不符');
});

const topLevel = fs.existsSync(packageDir) ? fs.readdirSync(packageDir) : [];
process.stdout.write(`  ℹ 包内顶层：${topLevel.join(', ') || '（读取失败）'}\n`);

// tarball 与 git 两条安装路径都已实测：pnpm 都按 files 收敛，只留 src / package.json / README / LICENSE。
// 一旦 test/ 之类的目录冒出来，就是打包边界失守（宿主会连测试与 CI 夹具一起下载）。
await check('包内不含 test/ 与 ci/ 夹具（files 收敛，两种安装都适用）', () => {
    for (const entry of ['test', 'ci', '.github']) {
        assert.ok(!topLevel.includes(entry), `已安装内容里出现 ${entry}/，files 字段未生效`);
    }
});

// —— 4. 最小行为可用 ————————————————————————————————————————————————
process.stdout.write('最小行为：\n');

await check('Router：basePath 剥离 + {id:int} 命中并转 number', () => {
    const router = new pkgRoot.Router({ basePath: '/api' });
    router.map('GET', '/user/{id:int}', () => undefined, 'user');

    const hit = router.match('/api/user/42', 'GET');
    assert.equal(hit.status, 'hit', `预期命中，实际 ${hit.status}`);
    assert.deepEqual(hit.params, { id: 42 }, 'int 参数应转为 number 42');

    assert.equal(router.match('/api/user/1x', 'GET').status, 'notFound', '{id:int} 不应命中非数字');
    assert.equal(router.match('/api/user/42', 'POST').status, 'methodNotAllowed', '方法不符应给 405 语义');
    assert.equal(router.generate('user', { id: 7 }), '/api/user/7', '反向路由应带 basePath');
});

await check('FuncResult：ok / fail 取值', () => {
    const ok = pkgRoot.FuncResult.ok({ a: 1 }, 200, '好的');
    assert.equal(ok.isSuccess(), true);
    assert.deepEqual(ok.getData(), { a: 1 });
    assert.equal(ok.getCode(), 200);
    assert.equal(ok.getMessage(), '好的');

    const fail = pkgRoot.FuncResult.fail('不行', 400);
    assert.equal(fail.isSuccess(), false);
    assert.equal(fail.getCode(), 400);
});

await check('HTTP_METHODS / encodeUrlParam 可用', () => {
    assert.ok(Array.isArray(pkgRoot.HTTP_METHODS ?? serverBarrel.HTTP_METHODS), 'HTTP_METHODS 应为数组');
    assert.ok(serverBarrel.HTTP_METHODS.includes('GET'));
    assert.equal(typeof serverBarrel.encodeUrlParam, 'function');
    assert.equal(serverBarrel.encodeUrlParam('a b'), 'a%20b');
});

// —— 结果 ——————————————————————————————————————————————————————————
if (failures.length > 0) {
    process.stderr.write(`\n冒烟失败 ${failures.length}/${checks}：\n- ${failures.join('\n- ')}\n`);
    process.exit(1);
}
process.stdout.write(`\n冒烟通过：${checks} 项断言全部成立\n`);
