import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError } from '#YukiLib/httpServer/appError';

describe('AppError', () => {
    it('默认：参数错误 / 400 / data 为 undefined', () => {
        const err = new AppError();
        assert.ok(err instanceof Error);
        assert.equal(err.name, 'AppError');
        assert.equal(err.message, '参数错误');
        assert.equal(err.statusCode, 400);
        assert.equal(err.data, undefined);
    });

    it('自定义消息、状态码与附加数据', () => {
        const err = new AppError('密钥错误', 401, { field: 'token' });
        assert.equal(err.message, '密钥错误');
        assert.equal(err.statusCode, 401);
        assert.deepEqual(err.data, { field: 'token' });
        assert.ok(/** @type {string} */ (err.stack).includes('AppError'));
    });

    it('可被 catch 按类判定（业务侧统一兜底出口依赖此语义）', () => {
        try {
            throw new AppError('参数错误', 422);
        } catch (err) {
            assert.ok(err instanceof AppError);
            assert.equal(/** @type {AppError} */ (err).statusCode, 422);
        }
    });
});
