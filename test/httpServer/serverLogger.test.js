import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { Logger } from '#YukiLib/logger';
import { ServerLogger } from '#YukiLib/httpServer/serverLogger';

import { makeCtx } from './contextFixture.js';

/**
 * ServerLogger：对基础设施 Logger 的服务器场景包装
 *
 * 通过替换 Logger 的静态方法捕获调用（每个测试文件独立进程，互不影响）。
 *
 * @typedef {{level: string, message: string, fields: Record<string, any>}} Captured
 */

/** @type {Captured[]} */
let captured = [];

/** 原始实现，用于用例结束后恢复 */
const originals = { info: Logger.info, warn: Logger.warn, error: Logger.error };

/**
 * 安装捕获
 */
function installCapture() {
    captured = [];
    Logger.info = (message, fields) => { captured.push({ level: 'info', message, fields: fields ?? {} }); };
    Logger.warn = (message, fields) => { captured.push({ level: 'warn', message, fields: fields ?? {} }); };
    Logger.error = (message, fields) => { captured.push({ level: 'error', message, fields: fields ?? {} }); };
}

afterEach(() => {
    Logger.info = originals.info;
    Logger.warn = originals.warn;
    Logger.error = originals.error;
    ServerLogger.configure({ serviceName: '', accessLevel: 'info' });
});

describe('ServerLogger', () => {
    it('configure 设置服务名，所有日志自动附带 service 字段', () => {
        installCapture();
        ServerLogger.configure({ serviceName: 'basic-api' });
        ServerLogger.startup('127.0.0.1', 8000);
        assert.equal(captured.length, 1);
        assert.equal(captured[0].level, 'info');
        assert.equal(captured[0].message, '服务已启动');
        assert.equal(captured[0].fields.service, 'basic-api');
        assert.equal(captured[0].fields.host, '127.0.0.1');
        assert.equal(captured[0].fields.port, 8000);
    });

    it('未配置服务名时不输出 service 字段', () => {
        installCapture();
        ServerLogger.startup('127.0.0.1', 8000);
        assert.equal(Object.prototype.hasOwnProperty.call(captured[0].fields, 'service'), false);
    });

    it('request(ctx)：请求级日志自动附加 requestId / method / path，并合并自定义字段', () => {
        installCapture();
        ServerLogger.configure({ serviceName: 'svc' });
        const ctx = makeCtx({ method: 'POST', path: '/api/v1/login', requestId: 'rid-1' });
        const log = ServerLogger.request(ctx);
        log.info('开始登录', { user: 'u1' });
        log.warn('慢查询', { ms: 900 });
        log.error('失败', { code: 500 });
        assert.equal(captured.length, 3);
        assert.deepEqual(captured[0].fields, { service: 'svc', requestId: 'rid-1', method: 'POST', path: '/api/v1/login', user: 'u1' });
        assert.equal(captured[1].level, 'warn');
        assert.equal(captured[1].fields.ms, 900);
        assert.equal(captured[2].level, 'error');
        assert.equal(captured[2].fields.code, 500);
    });

    it('access(ctx, status, ms)：输出状态码、耗时、IP 与 UA', () => {
        installCapture();
        const ctx = makeCtx({
            method: 'GET',
            path: '/api/v1/health',
            requestId: 'rid-2',
            headers: { 'user-agent': 'curl/8', 'x-forwarded-for': '203.0.113.7, 10.0.0.1' },
        });
        ServerLogger.access(ctx, 200, 12.6);
        assert.equal(captured.length, 1);
        assert.equal(captured[0].message, 'access');
        assert.equal(captured[0].fields.status, 200);
        assert.equal(captured[0].fields.ms, 13);
        assert.equal(captured[0].fields.ip, '203.0.113.7');
        assert.equal(captured[0].fields.ua, 'curl/8');
    });

    it('access：无代理头时回退 socket 地址', () => {
        installCapture();
        ServerLogger.access(makeCtx(), 404, 1);
        assert.equal(captured[0].fields.ip, '127.0.0.1');
        assert.equal(captured[0].fields.ua, '');
    });

    it('accessLevel 可切换为 warn（生产按需保留访问日志）', () => {
        installCapture();
        ServerLogger.configure({ accessLevel: 'warn' });
        ServerLogger.access(makeCtx(), 200, 1);
        assert.equal(captured[0].level, 'warn');
    });

    it('shutdown 输出关闭日志与耗时', () => {
        installCapture();
        ServerLogger.shutdown('SIGTERM', 3.2);
        assert.equal(captured[0].message, '服务已关闭');
        assert.equal(captured[0].fields.signal, 'SIGTERM');
        assert.equal(captured[0].fields.ms, 3);
    });

    it('error(message, err, fields)：err 原样交给 Logger 序列化', () => {
        installCapture();
        const err = new Error('boom');
        ServerLogger.error('服务器内部错误', err, { path: '/x' });
        assert.equal(captured[0].level, 'error');
        assert.equal(captured[0].fields.err, err);
        assert.equal(captured[0].fields.path, '/x');
    });
});
