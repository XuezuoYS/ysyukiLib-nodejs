import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as httpServerBarrel from 'ysyuki-lib-on-nodejs/httpServer';
import * as topBarrel from 'ysyuki-lib-on-nodejs';
import { AppError } from '#YukiLib/httpServer/appError';
import { RequestJson } from '#YukiLib/httpServer/requestJson';
import { Router } from '#YukiLib/httpServer/router';
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
    it('barrel 导出服务端三件套', () => {
        assert.deepEqual(
            Object.keys(httpServerBarrel).sort(),
            ['AppError', 'RequestJson', 'Router'],
        );
    });

    it('子域 barrel 与深子路径为同一实现（同一类对象）', () => {
        assert.equal(httpServerBarrel.AppError, AppError);
        assert.equal(httpServerBarrel.RequestJson, RequestJson);
        assert.equal(httpServerBarrel.Router, Router);
    });

    it('#YukiLib/httpServer 别名与子域 barrel 指向同一实现', () => {
        assert.equal(AliasRouter, Router);
    });

    it('子域 barrel 与顶层 barrel 为同一实现', () => {
        assert.equal(httpServerBarrel.AppError, topBarrel.AppError);
        assert.equal(httpServerBarrel.RequestJson, topBarrel.RequestJson);
        assert.equal(httpServerBarrel.Router, topBarrel.Router);
    });

    it('三件套均为可实例化的类', () => {
        assert.ok(new httpServerBarrel.Router() instanceof httpServerBarrel.Router);
        assert.ok(new httpServerBarrel.AppError('x') instanceof httpServerBarrel.AppError);
        assert.ok(new httpServerBarrel.RequestJson(null) instanceof httpServerBarrel.RequestJson);
    });
});
