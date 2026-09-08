import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Router } from '#YukiLib/httpServer/router';

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

describe('Router：批量注册', () => {
    it('constructor routes 数组与 addRoutes 均可用', () => {
        const viaCtor = new Router({ routes: [['GET', '/a', noop, 'a']] });
        assert.equal(viaCtor.match('/a', 'GET').status, 'hit');
        viaCtor.addRoutes([['GET', '/b', noop, { name: 'b' }]]);
        assert.equal(viaCtor.match('/b', 'GET').status, 'hit');
        assert.equal(viaCtor.getRoutes().length, 2);
    });
});
