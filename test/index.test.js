import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as barrel from 'ysyuki-lib-on-nodejs';
import { Config } from 'ysyuki-lib-on-nodejs/config';
import { Config as AliasConfig } from '#YukiLib/config';
import { Logger as AliasLogger } from '#YukiLib/logger';

/**
 * 包入口与子路径导出一致性
 *
 * 同时验证宿主项目可沿用的两种写法：
 * - 子路径：`import { Config } from 'ysyuki-lib-on-nodejs/config'`
 * - 别名：宿主 package.json 的 imports 把 `#YukiLib/*` 映射到本包子路径后，
 *   `import { Config } from '#YukiLib/config'` 写法成立。
 */
describe('包入口与子路径导出', () => {
    it('barrel 导出全部 11 个类', () => {
        assert.deepEqual(
            Object.keys(barrel).sort(),
            ['AppError', 'Config', 'FuncResult', 'HttpClient', 'HttpReq', 'HttpServer', 'JsonRes', 'Logger', 'Middleware', 'Router', 'ServerLogger'],
        );
    });

    it('子路径导出与 barrel 为同一实现（同一类对象）', () => {
        assert.equal(barrel.Config, Config);
        assert.equal(barrel.Logger, AliasLogger);
    });

    it('#YukiLib/* 别名与子路径指向同一实现', () => {
        assert.equal(AliasConfig, Config);
    });

    it('所有导出均为可调用的类', () => {
        for (const [name, value] of Object.entries(barrel)) {
            assert.equal(typeof value, 'function', `${name} 应为类`);
        }
        assert.ok(new barrel.Router() instanceof barrel.Router);
        assert.ok(barrel.FuncResult.ok() instanceof barrel.FuncResult);
        assert.ok(new barrel.HttpClient() instanceof barrel.HttpClient);
        assert.ok(new barrel.AppError('x') instanceof barrel.AppError);
        assert.equal(typeof barrel.HttpReq.getPostData, 'function');
        assert.equal(typeof barrel.HttpServer.create, 'function');
        assert.equal(typeof barrel.JsonRes.json, 'function');
        assert.equal(typeof barrel.Middleware.cors, 'function');
        assert.equal(typeof barrel.ServerLogger.access, 'function');
    });
});
