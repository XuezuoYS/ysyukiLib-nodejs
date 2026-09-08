import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Config } from '#YukiLib/config';
import { Logger } from '#YukiLib/logger';
import { ServerLogger } from '#YukiLib/httpServer/serverLogger';

import { captureStdout } from '../loggerFixture.js';
import { makeCtx, makeResStub } from './contextFixture.js';

/**
 * ServerLogger：实例化日志（服务名与记录等级随实例，配置互相隔离）
 *
 * 断言通过捕获 stdout 完成，不依赖库自身目录状态。
 */
const dir = mkdtempSync(join(tmpdir(), 'ysyuki-serverlogger-'));
writeFileSync(join(dir, 'dev.config.json'), '{}', 'utf8');
Config.setRootDir(dir);
Logger.logDir = join(dir, 'logs');

after(() => {
    Logger.logDir = null;
    Config.setRootDir(null);
    rmSync(dir, { recursive: true, force: true });
});

describe('ServerLogger', () => {
    it('serviceName 随实例：日志自动附带 service 字段', () => {
        const log = new ServerLogger({ serviceName: 'basic-api', level: 'info' });
        const entries = captureStdout(() => {
            log.startup('127.0.0.1', 8000);
            log.info('一般信息');
            log.warn('警告');
        });
        assert.deepEqual(entries.map((e) => e.message), ['服务已启动', '一般信息', '警告']);
        assert.deepEqual(entries.map((e) => e.fields.service), ['basic-api', 'basic-api', 'basic-api']);
        assert.equal(entries[0].fields.host, '127.0.0.1');
        assert.equal(entries[0].fields.port, 8000);
    });

    it('未配置服务名时不输出 service 字段', () => {
        const log = new ServerLogger({ level: 'info' });
        const entries = captureStdout(() => log.info('无服务名'));
        assert.equal(Object.prototype.hasOwnProperty.call(entries[0].fields, 'service'), false);
        assert.equal(log.serviceName, '');
    });

    it('request(ctx)：请求级日志附加 requestId / method / path 并合并自定义字段', () => {
        const log = new ServerLogger({ serviceName: 'svc', level: 'info' });
        const ctx = makeCtx({ method: 'POST', path: '/api/v1/login', requestId: 'rid-1' });
        const reqLog = log.request(ctx);
        const entries = captureStdout(() => {
            reqLog.info('开始登录', { user: 'u1' });
            reqLog.warn('慢查询', { ms: 900 });
            reqLog.error('失败', { code: 500 });
        });
        assert.deepEqual(entries.map((e) => e.level), ['INFO', 'WARN', 'ERROR']);
        assert.deepEqual(entries[0].fields, {
            service: 'svc', requestId: 'rid-1', method: 'POST', path: '/api/v1/login', user: 'u1',
        });
        assert.equal(entries[1].fields.ms, 900);
        assert.equal(entries[2].fields.code, 500);
    });

    it('request(ctx).access：输出状态码、耗时、IP 与 UA', () => {
        const log = new ServerLogger({ serviceName: 'svc', level: 'info' });
        const ctx = makeCtx({
            method: 'GET',
            path: '/api/v1/health',
            requestId: 'rid-2',
            headers: { 'user-agent': 'curl/8', 'x-forwarded-for': '203.0.113.7, 10.0.0.1' },
        });
        const entries = captureStdout(() => log.request(ctx).access(200, 12.6));
        assert.equal(entries[0].message, 'access');
        assert.equal(entries[0].fields.status, 200);
        assert.equal(entries[0].fields.ms, 13);
        assert.equal(entries[0].fields.ip, '203.0.113.7');
        assert.equal(entries[0].fields.ua, 'curl/8');
    });

    it('access：无代理头时回退 socket 地址', () => {
        const log = new ServerLogger({ level: 'info' });
        const entries = captureStdout(() => log.access(makeCtx(), 404, 1));
        assert.equal(entries[0].fields.ip, '127.0.0.1');
        assert.equal(entries[0].fields.ua, '');
    });

    it('等级阈值：warn 时 info 与 access 丢弃，warn/error 保留；改等级立即生效', () => {
        const log = new ServerLogger({ serviceName: 'svc', level: 'warn' });
        const ctx = makeCtx();
        const dropped = captureStdout(() => {
            log.info('丢弃');
            log.access(ctx, 200, 1);
            log.warn('保留');
            log.error('也保留', new Error('boom'));
        });
        assert.deepEqual(dropped.map((e) => e.level), ['WARN', 'ERROR']);

        log.level = 'info';
        assert.equal(log.level, 'info');
        const kept = captureStdout(() => log.info('改等级后记录'));
        assert.deepEqual(kept.map((e) => e.message), ['改等级后记录']);
    });

    it('实例隔离：不同实例的服务名与等级互不影响，也不影响根 Logger', () => {
        const a = new ServerLogger({ serviceName: 'a', level: 'error' });
        const b = new ServerLogger({ serviceName: 'b', level: 'info' });
        const entries = captureStdout(() => {
            a.info('a 丢弃');
            b.info('b 留下');
            Logger.info('根留下');
        });
        assert.deepEqual(entries.map((e) => e.message), ['b 留下', '根留下']);
        assert.equal(entries[0].fields.service, 'b');
        assert.equal(a.level, 'error');
        assert.equal(b.level, 'info');
        assert.equal(a.serviceName, 'a');
    });

    it('shutdown 输出关闭日志与耗时', () => {
        const log = new ServerLogger({ level: 'info' });
        const entries = captureStdout(() => log.shutdown('SIGTERM', 3.2));
        assert.equal(entries[0].message, '服务已关闭');
        assert.equal(entries[0].fields.signal, 'SIGTERM');
        assert.equal(entries[0].fields.ms, 3);
    });

    it('error(message, err, fields)：err 序列化为 message+stack', () => {
        const log = new ServerLogger({ level: 'info' });
        const entries = captureStdout(() => log.error('服务器内部错误', new Error('boom'), { path: '/x' }));
        assert.equal(entries[0].level, 'ERROR');
        assert.equal(entries[0].fields.err.message, 'boom');
        assert.ok(entries[0].fields.err.stack.includes('Error: boom'));
        assert.equal(entries[0].fields.path, '/x');
    });

    it('response：1/2/3 记 INFO、4/5 记 WARN，其它前缀不记', () => {
        const log = new ServerLogger({ serviceName: 'svc', level: 'info' });
        const ctx = makeCtx({ method: 'GET', url: '/api/v1/health?a=1#frag' });
        const entries = captureStdout(() => {
            log.response(ctx, 200);
            log.response(ctx, 301);
            log.response(ctx, 404);
            log.response(ctx, 503);
            log.response(ctx, 600);
            log.response(ctx, 999);
        });
        assert.deepEqual(entries.map((entry) => entry.level), ['INFO', 'INFO', 'WARN', 'WARN']);
        assert.deepEqual(entries.map((entry) => entry.fields.status), [200, 301, 404, 503]);
    });

    it('response：文本格式为「客户端IP 请求方式 响应代码 原始URL status描述」', () => {
        const log = new ServerLogger({ serviceName: 'svc', level: 'info' });
        const ctx = makeCtx({
            method: 'PUT',
            path: '/api/v1/orders',
            url: '/api/v1/orders?page=2#list',
            requestId: 'rid-3',
            headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' },
        });
        const entries = captureStdout(() => log.response(ctx, 404));
        // 请求方式归一为 OTHER；URL 取 req.url 原文（含查询串与 hash）
        assert.equal(entries[0].message, '203.0.113.7 OTHER 404 /api/v1/orders?page=2#list Not Found');
        assert.deepEqual(entries[0].fields, {
            service: 'svc', requestId: 'rid-3', method: 'PUT', path: '/api/v1/orders', status: 404,
        });
    });

    it('response：GET / POST 原样，其余方法归一为 OTHER；无代理头回退 socket 地址', () => {
        const log = new ServerLogger({ level: 'info' });
        const entries = captureStdout(() => {
            log.response(makeCtx({ method: 'GET', url: '/a' }), 200);
            log.response(makeCtx({ method: 'POST', url: '/b' }), 201);
            log.response(makeCtx({ method: 'DELETE', url: '/c' }), 204);
        });
        assert.deepEqual(entries.map((entry) => entry.message), [
            '127.0.0.1 GET 200 /a OK',
            '127.0.0.1 POST 201 /b Created',
            '127.0.0.1 OTHER 204 /c No Content',
        ]);
    });

    it('response：自定义码按首字符判级，无描述时输出 No status message', () => {
        const log = new ServerLogger({ level: 'info' });
        const ctx = makeCtx({ method: 'GET', url: '/x' });
        const entries = captureStdout(() => {
            log.response(ctx, 499);
            log.response(ctx, 4999);
        });
        // 4999 这类 4 位自定义码同样按 4 开头判级（不写 400-599 数值区间）
        assert.deepEqual(entries.map((entry) => entry.level), ['WARN', 'WARN']);
        assert.deepEqual(entries.map((entry) => entry.message), [
            '127.0.0.1 GET 499 /x No status message',
            '127.0.0.1 GET 4999 /x No status message',
        ]);
    });

    it('response：响应自带 statusMessage 优先于标准描述', () => {
        const log = new ServerLogger({ level: 'info' });
        const ctx = makeCtx({
            method: 'POST',
            url: '/x',
            res: makeResStub({ statusMessage: 'Rate Limited' }),
        });
        const entries = captureStdout(() => log.response(ctx, 429));
        assert.equal(entries[0].message, '127.0.0.1 POST 429 /x Rate Limited');
    });

    it('response：warn 阈值下 1/2/3 丢弃、4/5 保留', () => {
        const log = new ServerLogger({ level: 'warn' });
        const ctx = makeCtx({ method: 'GET', url: '/' });
        const entries = captureStdout(() => {
            log.response(ctx, 200);
            log.response(ctx, 404);
        });
        assert.deepEqual(entries.map((entry) => entry.level), ['WARN']);
    });

    it('request(ctx).response：请求级日志自动附带 service / requestId / method / path', () => {
        const log = new ServerLogger({ serviceName: 'svc', level: 'info' });
        const ctx = makeCtx({ method: 'GET', url: '/x?y=1', path: '/x', requestId: 'rid-4' });
        const entries = captureStdout(() => log.request(ctx).response(200));
        assert.equal(entries[0].level, 'INFO');
        assert.equal(entries[0].message, '127.0.0.1 GET 200 /x?y=1 OK');
        assert.deepEqual(entries[0].fields, {
            service: 'svc', requestId: 'rid-4', method: 'GET', path: '/x', status: 200,
        });
    });
});
