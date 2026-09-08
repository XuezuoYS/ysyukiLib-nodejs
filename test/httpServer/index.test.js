import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as httpServerBarrel from 'ysyuki-lib-on-nodejs/httpServer';
import * as topBarrel from 'ysyuki-lib-on-nodejs';
import { AppError } from '#YukiLib/httpServer/appError';
import { HttpReq } from '#YukiLib/httpServer/httpReq';
import { HttpServer } from '#YukiLib/httpServer/server';
import { JsonRes } from '#YukiLib/httpServer/jsonRes';
import { Middleware } from '#YukiLib/httpServer/middleware';
import { Router } from '#YukiLib/httpServer/router';
import { ServerLogger } from '#YukiLib/httpServer/serverLogger';
import { Router as AliasRouter } from '#YukiLib/httpServer';

/**
 * 入站 HTTP 服务端子域入口（httpServer barrel）导出契约
 *
 * 验证三种写法指向同一实现（同一类对象）：
 * - 子域 barrel：`ysyuki-lib-on-nodejs/httpServer` 与别名 `#YukiLib/httpServer`；
 * - 深子路径：`#YukiLib/httpServer/router` 等（通配符 `./*` 派生）；
 * - 顶层 barrel：`ysyuki-lib-on-nodejs`。
 */
describe('httpServer 子域入口与子路径导出', () => {
    it('barrel 导出服务端框架成员', () => {
        assert.deepEqual(
            Object.keys(httpServerBarrel).sort(),
            ['AppError', 'HttpReq', 'HttpServer', 'JsonRes', 'Middleware', 'Router', 'ServerLogger'],
        );
    });

    it('子域 barrel 与深子路径为同一实现（同一类对象）', () => {
        assert.equal(httpServerBarrel.AppError, AppError);
        assert.equal(httpServerBarrel.HttpReq, HttpReq);
        assert.equal(httpServerBarrel.HttpServer, HttpServer);
        assert.equal(httpServerBarrel.JsonRes, JsonRes);
        assert.equal(httpServerBarrel.Middleware, Middleware);
        assert.equal(httpServerBarrel.Router, Router);
        assert.equal(httpServerBarrel.ServerLogger, ServerLogger);
    });

    it('#YukiLib/httpServer 别名与子域 barrel 指向同一实现', () => {
        assert.equal(AliasRouter, Router);
    });

    it('子域 barrel 与顶层 barrel 为同一实现', () => {
        for (const key of ['AppError', 'HttpReq', 'HttpServer', 'JsonRes', 'Middleware', 'Router', 'ServerLogger']) {
            assert.equal(httpServerBarrel[key], topBarrel[key], `${key} 应为同一实现`);
        }
    });

    it('成员均为可用的类', () => {
        assert.ok(new httpServerBarrel.Router() instanceof httpServerBarrel.Router);
        assert.ok(new httpServerBarrel.AppError('x') instanceof httpServerBarrel.AppError);
        assert.equal(typeof httpServerBarrel.HttpReq.getPostData, 'function');
        assert.equal(typeof httpServerBarrel.HttpServer.create, 'function');
        assert.equal(typeof httpServerBarrel.JsonRes.json, 'function');
        assert.equal(typeof httpServerBarrel.Middleware.cors, 'function');
        assert.equal(typeof httpServerBarrel.ServerLogger.access, 'function');
    });
});
