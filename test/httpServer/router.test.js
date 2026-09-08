import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Logger } from '#YukiLib/logger';
import { Router, encodeUrlParam } from '#YukiLib/httpServer/router';

import { captureStdout } from '../loggerFixture.js';

/**
 * 日志目录重定向到临时目录，避免护栏告警落盘污染库自身目录
 */
const logDir = mkdtempSync(join(tmpdir(), 'ysyuki-router-log-'));
Logger.logDir = logDir;

after(() => {
    Logger.logDir = null;
    rmSync(logDir, { recursive: true, force: true });
});

/** @type {Function} 路由占位处理器 */
const noop = () => {};

describe('Router：静态路由与方法匹配', () => {
    const router = new Router();
    router.map('GET', '/health', noop, 'health');
    router.map('GET|POST', '/multi', noop);

    it('精确匹配', () => {
        const match = router.match('/health', 'GET');
        assert.equal(match.status, 'hit');
        assert.equal(match.name, 'health');
        assert.deepEqual(match.params, {});
    });

    it('路径命中而方法不符：methodNotAllowed 并给出 allowed（405 用）', () => {
        const post = router.match('/health', 'POST');
        assert.equal(post.status, 'methodNotAllowed');
        assert.deepEqual(post.allowed, ['GET']);
        assert.equal(post.target, null);

        const put = router.match('/multi', 'PUT');
        assert.equal(put.status, 'methodNotAllowed');
        assert.deepEqual(put.allowed, ['GET', 'POST']);
    });

    it('路径未命中：notFound', () => {
        const miss = router.match('/nope', 'GET');
        assert.equal(miss.status, 'notFound');
        assert.deepEqual(miss.allowed, []);
    });

    it('多方法 GET|POST 与方法大小写不敏感', () => {
        assert.equal(router.match('/multi', 'GET').status, 'hit');
        assert.equal(router.match('/multi', 'POST').status, 'hit');
        assert.equal(router.match('/health', 'get').status, 'hit');
    });

    it('HEAD 可命中 GET 路由（响应体由入口层抑制）', () => {
        assert.equal(router.match('/health', 'HEAD').status, 'hit');
    });

    it('any() 注册的路由接受任意方法', () => {
        const r = new Router();
        r.any('/x', noop);
        for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']) {
            assert.equal(r.match('/x', method).status, 'hit', method);
        }
    });

    it('多匹配时返回先注册的路由', () => {
        const r2 = new Router();
        r2.map('GET', '/x', noop, 'first');
        r2.map('GET', '/x', noop, 'second');
        assert.equal(r2.match('/x', 'GET').name, 'first');
    });

    it('命名路由重复注册抛错', () => {
        const r3 = new Router();
        r3.map('GET', '/a', noop, 'dup');
        assert.throws(() => r3.map('GET', '/b', noop, 'dup'), /Can not redeclare route 'dup'/);
    });

    it('尾斜杠默认忽略（可关闭）', () => {
        const r4 = new Router();
        r4.get('/a', noop);
        assert.equal(r4.match('/a/', 'GET').status, 'hit');

        const strict = new Router({ trailingSlash: 'strict' });
        strict.get('/a', noop);
        assert.equal(strict.match('/a/', 'GET').status, 'notFound');
        assert.equal(strict.match('/a', 'GET').status, 'hit');
    });
});

describe('Router：模板占位符类型', () => {
    it('{uid:int} 仅数字，并按类型转为 number', () => {
        const r = new Router();
        r.get('/user/{uid:int}', noop);
        assert.deepEqual(r.match('/user/12', 'GET').params, { uid: 12 });
        assert.equal(r.match('/user/1x', 'GET').status, 'notFound');
        assert.equal(r.match('/user/', 'GET').status, 'notFound');
        assert.equal(r.match('/user/1/2', 'GET').status, 'notFound');
    });

    it('{mod:alpha} 字母数字', () => {
        const r = new Router();
        r.get('/{mod:alpha}/{id:int}', noop);
        assert.deepEqual(r.match('/account/123', 'GET').params, { mod: 'account', id: 123 });
        assert.equal(r.match('/acc-ount/123', 'GET').status, 'notFound');
    });

    it('{id:hex} 十六进制', () => {
        const r = new Router();
        r.get('/hex/{id:hex}', noop);
        assert.deepEqual(r.match('/hex/ff00AB', 'GET').params, { id: 'ff00AB' });
        assert.equal(r.match('/hex/zz', 'GET').status, 'notFound');
    });

    it('{page} 默认字符串：不含斜杠但允许点号', () => {
        const r = new Router();
        r.get('/doc/{page}', noop);
        assert.deepEqual(r.match('/doc/abc', 'GET').params, { page: 'abc' });
        assert.deepEqual(r.match('/doc/a.b', 'GET').params, { page: 'a.b' });
        assert.equal(r.match('/doc/a/b', 'GET').status, 'notFound');
    });

    it('{flag:bool} / {ratio:float}', () => {
        const r = new Router();
        r.get('/b/{flag:bool}', noop);
        r.get('/f/{ratio:float}', noop);
        assert.deepEqual(r.match('/b/true', 'GET').params, { flag: true });
        assert.equal(r.match('/b/yes', 'GET').status, 'notFound');
        assert.deepEqual(r.match('/f/1.5', 'GET').params, { ratio: 1.5 });
        assert.equal(r.match('/f/1.5.6', 'GET').status, 'notFound');
    });

    it('{path:path} 跨斜杠非贪婪，至少一个字符', () => {
        const r = new Router();
        r.get('/view/{path:path}', noop);
        assert.deepEqual(r.match('/view/a/b/c', 'GET').params, { path: 'a/b/c' });
        assert.equal(r.match('/view/', 'GET').status, 'notFound');
    });

    it('{rest:all} 跨斜杠且包含尾斜杠', () => {
        const r = new Router();
        r.get('/all{rest:all}', noop);
        assert.deepEqual(r.match('/allx.y', 'GET').params, { rest: 'x.y' });
    });

    it('点号前缀：/file.{ext} 形式', () => {
        const r = new Router();
        r.get('/file.{ext:alpha}', noop);
        assert.deepEqual(r.match('/file.tar', 'GET').params, { ext: 'tar' });
        assert.equal(r.match('/filetar', 'GET').status, 'notFound');
    });

    it('addMatchTypes 追加自定义类型；未知类型注册即抛错', () => {
        const r = new Router({ types: { d: '[0-9]{2}' } });
        r.get('/x/{dd:d}', noop);
        assert.deepEqual(r.match('/x/12', 'GET').params, { dd: '12' });
        assert.equal(r.match('/x/1', 'GET').status, 'notFound');

        assert.throws(() => new Router().get('/y/{v:unknownType}', noop), /未知的路由类型/);
    });
});

describe('Router：可选段与真实路由样本', () => {
    const r = new Router();
    r.get('/opt/{page:int?}', noop);
    // 生产路由样本（1:1 验证匹配行为）
    r.get('/test/{sum1:int}/{sum2:int}/{text:alpha}/{path:path?}', noop);

    it('可选段缺失时 params 不含该键', () => {
        assert.deepEqual(r.match('/opt', 'GET').params, {});
        assert.deepEqual(r.match('/opt/2', 'GET').params, { page: 2 });
    });

    it('{name?} 简写同样支持', () => {
        const r2 = new Router();
        r2.get('/s/{q?}', noop);
        assert.deepEqual(r2.match('/s', 'GET').params, {});
        assert.deepEqual(r2.match('/s/abc', 'GET').params, { q: 'abc' });
    });

    it('完整还原生产路由样本匹配', () => {
        assert.deepEqual(r.match('/test/1/2/abc', 'GET').params, { sum1: 1, sum2: 2, text: 'abc' });
        assert.deepEqual(r.match('/test/1/2/abc/x/y', 'GET').params, {
            sum1: 1, sum2: 2, text: 'abc', path: 'x/y',
        });
        assert.equal(r.match('/test/1/2/', 'GET').status, 'notFound');
    });

    it('URL 以斜杠结尾时不因可选段而误匹配', () => {
        assert.equal(r.match('/test/1/2', 'GET').status, 'notFound');
    });
});

describe('Router：@ 自定义正则 / 通配 / basePath / 查询串', () => {
    it('@ 前缀自定义正则（命名组转 params，数字组丢弃）', () => {
        const r = new Router();
        r.map('GET', '@^/raw/(?<n>[0-9]+)$', noop);
        assert.deepEqual(r.match('/raw/55', 'GET').params, { n: '55' });
        const r2 = new Router();
        r2.map('GET', '@^/raw2/([0-9]+)$', noop);
        assert.deepEqual(r2.match('/raw2/55', 'GET').params, {});
        assert.equal(r2.match('/raw2/x', 'GET').status, 'notFound');
    });

    it('* 通配全部匹配', () => {
        const r = new Router();
        r.map('GET', '*', noop, 'catchall');
        assert.equal(r.match('/whatever/deep', 'GET').name, 'catchall');
        assert.equal(r.match('', 'GET').name, 'catchall');
    });

    it('basePath 剥离后匹配', () => {
        const r = new Router({ basePath: '/sub' });
        r.get('/x', noop);
        assert.equal(r.match('/sub/x', 'GET').status, 'hit');
        assert.equal(r.match('/x', 'GET').status, 'notFound');
    });

    it('basePath 只剥离完整前缀：/subx 不再被切成 x', () => {
        const r = new Router({ basePath: '/sub' });
        r.get('/x', noop);
        assert.equal(r.match('/sub/x', 'GET').status, 'hit');
        assert.equal(r.match('/subx', 'GET').status, 'notFound');
        assert.equal(r.match('/subx/x', 'GET').status, 'notFound');
    });

    it('basePath 本身（含查询串）映射到根路径', () => {
        const r = new Router({ basePath: '/sub' });
        r.get('/', noop, 'root');
        assert.equal(r.match('/sub', 'GET').status, 'hit');
        assert.equal(r.match('/sub/', 'GET').status, 'hit');
        assert.equal(r.match('/sub?a=1', 'GET').status, 'hit');
    });

    it('basePath 前缀不匹配时通配路由也不命中', () => {
        const r = new Router({ basePath: '/sub' });
        r.map('GET', '*', noop, 'catchall');
        assert.equal(r.match('/sub/anything', 'GET').name, 'catchall');
        assert.equal(r.match('/other', 'GET').status, 'notFound');
    });

    it('match 内剥离查询串', () => {
        const r = new Router();
        r.get('/health', noop);
        assert.equal(r.match('/health?a=b', 'GET').status, 'hit');
    });
});

describe('Router：分组与中间件绑定', () => {
    it('分组前缀叠加（含嵌套）', () => {
        const r = new Router();
        r.group('/v1', (v1) => {
            v1.get('/a', noop, 'a');
            v1.group('/admin', (admin) => {
                admin.get('/stats', noop, 'stats');
            });
        });
        assert.equal(r.match('/v1/a', 'GET').status, 'hit');
        assert.equal(r.match('/v1/admin/stats', 'GET').status, 'hit');
        assert.equal(r.generate('stats'), '/v1/admin/stats');
    });

    it('分组内 use 的中间件只绑定该分组后续注册的路由', () => {
        const globalMw = () => {};
        const groupMw = () => {};
        const r = new Router();
        r.use(globalMw);
        r.group('/v1', (v1) => {
            v1.use(groupMw);
            v1.get('/in', noop);
        });
        r.get('/out', noop);

        assert.deepEqual(r.globalMiddleware, [globalMw]);
        assert.deepEqual(r.match('/v1/in', 'GET').middleware, [groupMw]);
        assert.deepEqual(r.match('/out', 'GET').middleware, []);
    });

    it('options.middleware 绑定单条路由，options.name 注册命名路由', () => {
        const routeMw = () => {};
        const r = new Router();
        r.get('/x/{id:int}', noop, { name: 'x', middleware: [routeMw] });
        assert.deepEqual(r.match('/x/1', 'GET').middleware, [routeMw]);
        assert.equal(r.generate('x', { id: 1 }), '/x/1');
    });
});

describe('Router：generate 反向路由', () => {
    it('参数替换', () => {
        const r = new Router();
        r.map('GET', '/user/{uid:int}', noop, 'user');
        assert.equal(r.generate('user', { uid: 7 }), '/user/7');
    });

    it('必填参数缺失：抛明确错误（不再静默生成错误 URL）', () => {
        const r = new Router();
        r.map('GET', '/user/{uid:int}', noop, 'user');
        assert.throws(() => r.generate('user'), /requires parameter 'uid'/);
    });

    it('可选段缺失：连同分隔符一起剥离', () => {
        const r = new Router();
        r.map('GET', '/opt/{page:int?}', noop, 'opt');
        assert.equal(r.generate('opt'), '/opt');
        assert.equal(r.generate('opt', { page: 3 }), '/opt/3');
    });

    it('未知名抛错', () => {
        assert.throws(() => new Router().generate('nope'), /Route 'nope' does not exist/);
    });
});

describe('Router：反向路由参数编码', () => {
    it('encodeUrlParam：结构字符编码，keepSlash 保留分隔符', () => {
        assert.equal(encodeUrlParam('AC/DC'), 'AC%2FDC');
        assert.equal(encodeUrlParam('report#2'), 'report%232');
        assert.equal(encodeUrlParam('a?b'), 'a%3Fb');
        assert.equal(encodeUrlParam('a b'), 'a%20b');
        assert.equal(encodeUrlParam('100%'), '100%25');
        assert.equal(encodeUrlParam('中文'), '%E4%B8%AD%E6%96%87');
        assert.equal(encodeUrlParam(42), '42');
        assert.equal(encodeUrlParam('a/b c', { keepSlash: true }), 'a/b%20c');
    });

    it('generate 默认编码参数值：结构字符不再破坏 URL', () => {
        const r = new Router();
        r.map('GET', '/file/{name}', noop, 'file');
        assert.equal(r.generate('file', { name: 'AC/DC' }), '/file/AC%2FDC');
        assert.equal(r.generate('file', { name: 'report#2' }), '/file/report%232');
        assert.equal(r.generate('file', { name: 'a?b' }), '/file/a%3Fb');
        assert.equal(r.generate('file', { name: 'a b' }), '/file/a%20b');
    });

    it('generate：{path:path} 按段编码并保留斜杠', () => {
        const r = new Router();
        r.map('GET', '/view/{path:path}', noop, 'view');
        assert.equal(r.generate('view', { path: 'a/b c' }), '/view/a/b%20c');
        assert.equal(r.generate('view', { path: 'x#y/z' }), '/view/x%23y/z');
    });

    it('generate({ encode: false })：保留原始拼接行为（逃生开关）', () => {
        const r = new Router();
        r.map('GET', '/file/{name}', noop, 'file');
        assert.equal(r.generate('file', { name: 'AC/DC' }, { encode: false }), '/file/AC/DC');
    });

    it('generate：值里含块文本不被二次替换（按原串位置替换）', () => {
        const r = new Router();
        r.map('GET', '/x/{a}/{b}', noop, 'pair');
        r.map('GET', '/y/{a}', noop, 'single');

        // encode:false 时值原样落进 URL，修复前会被当成占位符再替换一次
        assert.equal(r.generate('pair', { a: '{b}', b: 'B' }, { encode: false }), '/x/{b}/B');
        assert.equal(r.generate('pair', { a: 'A', b: '{b}' }, { encode: false }), '/x/A/{b}');
        assert.equal(r.generate('single', { a: '{a}' }, { encode: false }), '/y/{a}');
        // 默认编码下值里的花括号会被编码，本来就不会命中块文本
        assert.equal(r.generate('pair', { a: '{b}', b: 'B' }), '/x/%7Bb%7D/B');
    });

    it('generate + match 往返：保留字符以百分号形式到达处理器（已知语义）', () => {
        const r = new Router();
        r.map('GET', '/file/{name}', noop, 'file');
        const url = r.generate('file', { name: 'AC/DC' });
        assert.equal(url, '/file/AC%2FDC');
        // decodeURI 不解码保留字符，路由也不解码参数 → 处理器拿到仍编码的值
        assert.deepEqual(r.match(url, 'GET').params, { name: 'AC%2FDC' });
    });

    it('@ 自定义正则路由不支持反向生成：抛明确错误', () => {
        const r = new Router();
        r.map('GET', '@^/raw/(?<n>[0-9]+)$', noop, 'raw');
        assert.throws(() => r.generate('raw', { n: 5 }), /不支持反向生成/);
    });
});

describe('Router：批量注册', () => {
    it('constructor routes 数组与 addRoutes 均可用', () => {
        const viaCtor = new Router({ routes: [['GET', '/a', noop, 'a']] });
        assert.equal(viaCtor.match('/a', 'GET').status, 'hit');
        viaCtor.addRoutes([['GET', '/b', noop, { name: 'b' }]]);
        assert.equal(viaCtor.match('/b', 'GET').status, 'hit');
        assert.equal(viaCtor.getRoutes().length, 2);
    });
});

describe('Router：块外字面量的正则转义', () => {
    it('点号是字面量：/a.b/{id:int} 不再命中 /axb/7', () => {
        const r = new Router();
        r.get('/a.b/{id:int}', noop);
        assert.deepEqual(r.match('/a.b/7', 'GET').params, { id: 7 });
        assert.equal(r.match('/axb/7', 'GET').status, 'notFound');
        assert.equal(r.match('/a-b/7', 'GET').status, 'notFound');
    });

    it('量词与字符组元字符都是字面量', () => {
        const r = new Router();
        r.get('/v1+2/{id}', noop);
        r.get('/a(b/{id:int}', noop);
        r.get('/fee$/x/{id:int}', noop);
        r.get('/[a]/{id:int}', noop);
        r.get('/a|b/{id:int}', noop);
        r.get('/a\\b/{id:int}', noop);
        r.get('/a}b/{id:int}', noop);

        assert.equal(r.match('/v1+2/abc', 'GET').status, 'hit');
        assert.equal(r.match('/v1112/abc', 'GET').status, 'notFound');
        assert.equal(r.match('/a(b/7', 'GET').status, 'hit');
        assert.equal(r.match('/ab/7', 'GET').status, 'notFound');
        assert.equal(r.match('/fee$/x/7', 'GET').status, 'hit');
        assert.equal(r.match('/feex/7', 'GET').status, 'notFound');
        assert.equal(r.match('/[a]/7', 'GET').status, 'hit');
        assert.equal(r.match('/x[ay]/7', 'GET').status, 'notFound');
        assert.equal(r.match('/a|b/7', 'GET').status, 'hit');
        assert.equal(r.match('/a/7', 'GET').status, 'notFound');
        assert.equal(r.match('/a\\b/7', 'GET').status, 'hit');
        assert.equal(r.match('/ab/7', 'GET').status, 'notFound');
        assert.equal(r.match('/a}b/7', 'GET').status, 'hit');
        // 路径里的 `?` 先按查询串剥离（见"match 内剥离查询串"），故不构造 `?` 字面量路由
    });

    it('模板里的 * 是字面量（仅整条路由为 * 时通配）', () => {
        const r = new Router();
        r.get('/a*{id:int}', noop);
        assert.deepEqual(r.match('/a*7', 'GET').params, { id: 7 });
        assert.equal(r.match('/a7', 'GET').status, 'notFound');
        assert.equal(r.match('/7', 'GET').status, 'notFound');

        const catchall = new Router();
        catchall.map('GET', '*', noop, 'catchall');
        assert.equal(catchall.match('/whatever/deep', 'GET').name, 'catchall');
    });

    it('分组前缀与块后缀字面量同样转义', () => {
        const r = new Router();
        r.group('/v1.0', (v1) => {
            v1.get('/x/{id:int}', noop, 'x');
        });
        assert.equal(r.match('/v1.0/x/5', 'GET').status, 'hit');
        assert.equal(r.match('/v1x0/x/5', 'GET').status, 'notFound');
        // generate 输出 URL 字面量（不带反斜杠），与转义后的正则仍能往返
        assert.equal(r.generate('x', { id: 5 }), '/v1.0/x/5');
        assert.equal(r.match(r.generate('x', { id: 5 }), 'GET').status, 'hit');

        const suffix = new Router();
        suffix.map('GET', '/report.{id:int}.pdf', noop, 'report');
        assert.equal(suffix.generate('report', { id: 7 }), '/report.7.pdf');
        assert.equal(suffix.match('/report.7.pdf', 'GET').status, 'hit');
        assert.equal(suffix.match('/reportX7pdf', 'GET').status, 'notFound');
    });

    it('转义只作用于字面量：类型正则与可选段语义不变', () => {
        const r = new Router();
        r.get('/file.{ext:alpha}.{name}', noop);
        assert.deepEqual(r.match('/file.tar.gz', 'GET').params, { ext: 'tar', name: 'gz' });
        assert.equal(r.match('/filetargz', 'GET').status, 'notFound');

        const opt = new Router();
        opt.map('GET', '/opt/{page:int?}', noop, 'opt');
        assert.deepEqual(opt.match('/opt', 'GET').params, {});
        assert.deepEqual(opt.match('/opt/3', 'GET').params, { page: 3 });
        assert.equal(opt.generate('opt'), '/opt');
    });

    it('@ 自定义正则不被转义（整条仍是正则）', () => {
        const r = new Router();
        r.map('GET', '@^/raw/(?<n>[0-9]+)$', noop);
        assert.deepEqual(r.match('/raw/55', 'GET').params, { n: '55' });

        const dot = new Router();
        dot.map('GET', '@/raw/(?<n>[0-9]+)', noop);
        assert.deepEqual(dot.match('/raw/55', 'GET').params, { n: '55' });
        assert.equal(dot.match('/rawx55', 'GET').status, 'notFound');
    });
});

describe('Router：注册期正则护栏与 @ 锚定', () => {
    it('@ 模式缺锚定：自动补 ^...$，不再子串命中', () => {
        const r = new Router();
        r.map('GET', '@/raw/(?<n>[0-9]+)', noop);
        assert.deepEqual(r.match('/raw/55', 'GET').params, { n: '55' });
        assert.equal(r.match('/x/raw/55/y', 'GET').status, 'notFound');
        assert.equal(r.match('/raw/55/y', 'GET').status, 'notFound');
    });

    it('@ 模式已写锚定：不重复补，行为不变', () => {
        const r = new Router();
        r.map('GET', '@^/raw/(?<n>[0-9]+)$', noop);
        assert.deepEqual(r.match('/raw/55', 'GET').params, { n: '55' });
        assert.equal(r.match('/x/raw/55', 'GET').status, 'notFound');
    });

    it('@ 模式超长：注册即抛错', () => {
        assert.throws(() => new Router().map('GET', `@^/${'a'.repeat(1100)}$`, noop), /路由正则过长/);
    });

    it('自定义类型片段超长：使用该类型注册路由时抛错', () => {
        const r = new Router({ types: { long: 'a'.repeat(1100) } });
        assert.throws(() => r.get('/x/{v:long}', noop), /路由正则过长/);
    });

    it('嵌套量词：仅告警不阻断，注册与匹配均正常', () => {
        const entries = captureStdout(() => {
            const r = new Router();
            r.map('GET', '@^/(a+)+$', noop);
            assert.equal(r.match('/aaa', 'GET').status, 'hit');
        });
        const warned = entries.filter((e) => e.message.includes('灾难性回溯'));
        assert.equal(warned.length, 1);
        assert.equal(warned[0].level, 'WARN');
        assert.ok(warned[0].fields.origin.includes('(a+)+'));
    });

    it('自定义类型片段的嵌套量词同样告警', () => {
        const entries = captureStdout(() => {
            const r = new Router({ types: { evil: '(a+)+' } });
            r.get('/x/{v:evil}', noop);
        });
        assert.equal(entries.filter((e) => e.message.includes('灾难性回溯')).length, 1);
    });

    it('正常模式不告警', () => {
        const entries = captureStdout(() => {
            const r = new Router();
            r.get('/user/{uid:int}', noop);
            r.map('GET', '@^/raw/(?<n>[0-9]+)$', noop);
        });
        assert.deepEqual(entries, []);
    });
});
