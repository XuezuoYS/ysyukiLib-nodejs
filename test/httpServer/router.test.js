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
        assert.ok(match);
        assert.equal(match.name, 'health');
        assert.deepEqual(match.params, {});
    });

    it('方法不符返回 null', () => {
        assert.equal(router.match('/health', 'POST'), null);
        assert.equal(router.match('/multi', 'PUT'), null);
    });

    it('多方法 GET|POST 与方法大小写不敏感（stripos 语义）', () => {
        assert.ok(router.match('/multi', 'GET'));
        assert.ok(router.match('/multi', 'POST'));
        assert.ok(router.match('/health', 'get'));
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
});

describe('Router：占位符类型', () => {
    it('[i:] 仅数字', () => {
        const r = new Router();
        r.map('GET', '/user/[i:uid]', noop);
        assert.deepEqual(r.match('/user/12', 'GET').params, { uid: '12' });
        assert.equal(r.match('/user/1x', 'GET'), null);
        assert.equal(r.match('/user/', 'GET'), null);
        assert.equal(r.match('/user/1/2', 'GET'), null);
    });

    it('[a:] 字母数字', () => {
        const r = new Router();
        r.map('GET', '/[a:mod]/[i:id]', noop);
        assert.deepEqual(r.match('/account/123', 'GET').params, { mod: 'account', id: '123' });
        assert.equal(r.match('/acc-ount/123', 'GET'), null);
    });

    it('[h:] 十六进制', () => {
        const r = new Router();
        r.map('GET', '/hex/[h:id]', noop);
        assert.deepEqual(r.match('/hex/ff00AB', 'GET').params, { id: 'ff00AB' });
        assert.equal(r.match('/hex/zz', 'GET'), null);
    });

    it('[:name] 空类型：不含斜杠与点', () => {
        const r = new Router();
        r.map('GET', '/doc/[:page]', noop);
        assert.deepEqual(r.match('/doc/abc', 'GET').params, { page: 'abc' });
        assert.equal(r.match('/doc/a.b', 'GET'), null);
        assert.equal(r.match('/doc/a/b', 'GET'), null);
    });

    it('[*:path] 至少一个字符、跨斜杠非贪婪', () => {
        const r = new Router();
        r.map('GET', '/view/[*:path]', noop);
        assert.deepEqual(r.match('/view/a/b/c', 'GET').params, { path: 'a/b/c' });
        assert.equal(r.match('/view/', 'GET'), null);
    });

    it('[**:rest] 任意内容（占有量词在锚定语义下等价替换）', () => {
        const r = new Router();
        r.map('GET', '/all[**:rest]', noop);
        assert.deepEqual(r.match('/allx.y/', 'GET').params, { rest: 'x.y/' });
    });

    it('addMatchTypes 追加自定义类型', () => {
        const r = new Router();
        r.addMatchTypes({ d: '[0-9]{2}' });
        r.map('GET', '/x/[d:dd]', noop);
        assert.deepEqual(r.match('/x/12', 'GET').params, { dd: '12' });
        assert.equal(r.match('/x/1', 'GET'), null);
    });
});

describe('Router：可选段 ? 与真实路由样本', () => {
    const r = new Router();
    r.map('GET', '/opt/[i:page]?', noop);
    // 生产路由样本（1:1 验证匹配行为）
    r.map('GET', '/test/[i:sum1]/[i:sum2]/[a:text]/[*:path]?', noop);

    it('可选段缺失时 params 不含该键', () => {
        assert.deepEqual(r.match('/opt', 'GET').params, {});
        assert.deepEqual(r.match('/opt/2', 'GET').params, { page: '2' });
    });

    it('完整还原生产路由样本匹配', () => {
        assert.deepEqual(r.match('/test/1/2/abc', 'GET').params, { sum1: '1', sum2: '2', text: 'abc' });
        assert.deepEqual(r.match('/test/1/2/abc/x/y', 'GET').params, {
            sum1: '1', sum2: '2', text: 'abc', path: 'x/y',
        });
        assert.equal(r.match('/test/1/2/', 'GET'), null);
    });

    it('#241 场景：URL 以斜杠结尾时不因前缀豁免而误匹配', () => {
        assert.equal(r.match('/test/1/2', 'GET'), null);
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
        assert.equal(r2.match('/raw2/x', 'GET'), null);
    });

    it('* 通配全部匹配', () => {
        const r = new Router();
        r.map('GET', '*', noop, 'catchall');
        assert.equal(r.match('/whatever/deep', 'GET').name, 'catchall');
        assert.equal(r.match('', 'GET').name, 'catchall');
    });

    it('basePath 剥离后匹配', () => {
        const r = new Router([], '/sub');
        r.map('GET', '/x', noop);
        assert.ok(r.match('/sub/x', 'GET'));
        assert.equal(r.match('/x', 'GET'), null);
    });

    it('match 内剥离查询串', () => {
        const r = new Router();
        r.map('GET', '/health', noop);
        assert.ok(r.match('/health?a=b', 'GET'));
    });
});

describe('Router：generate 反向路由', () => {
    it('参数替换', () => {
        const r = new Router();
        r.map('GET', '/user/[i:uid]', noop, 'user');
        assert.equal(r.generate('user', { uid: 7 }), '/user/7');
        assert.equal(r.generate('user'), '/user/');
    });

    it('可选段剥离（首块可选段剥离后保留原前缀斜杠）', () => {
        const r = new Router();
        r.map('GET', '/opt/[i:page]?', noop, 'opt');
        assert.equal(r.generate('opt'), '/opt/');
        assert.equal(r.generate('opt', { page: 3 }), '/opt/3');
    });

    it('未知名抛错', () => {
        assert.throws(() => new Router().generate('nope'), /Route 'nope' does not exist/);
    });
});

describe('Router：批量注册（原 registerRouter 模式）', () => {
    it('constructor routes 数组与 addRoutes 均可用', () => {
        const viaCtor = new Router([['GET', '/a', noop, 'a']]);
        assert.ok(viaCtor.match('/a', 'GET'));
        viaCtor.addRoutes([['GET', '/b', noop, 'b']]);
        assert.ok(viaCtor.match('/b', 'GET'));
        assert.equal(viaCtor.getRoutes().length, 2);
    });
});
