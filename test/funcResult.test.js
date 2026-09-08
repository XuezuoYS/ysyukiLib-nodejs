import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FuncResult } from '#YukiLib/funcResult';

describe('FuncResult', () => {
    it('ok：默认 message=成功、code=0、data=null', () => {
        const result = FuncResult.ok();
        assert.equal(result.isSuccess(), true);
        assert.equal(result.getMessage(), '成功');
        assert.equal(result.getData(), null);
        assert.equal(result.getCode(), 0);
    });

    it('ok：携带数据与自定义 code/message', () => {
        const result = FuncResult.ok({ uid: 7 }, 1, '已存在');
        assert.equal(result.isSuccess(), true);
        assert.deepEqual(result.getData(), { uid: 7 });
        assert.equal(result.getCode(), 1);
        assert.equal(result.getMessage(), '已存在');
    });

    it('fail：message 必填、code 默认 0、data 恒 null', () => {
        const result = FuncResult.fail('邮件发送失败', 500);
        assert.equal(result.isSuccess(), false);
        assert.equal(result.getMessage(), '邮件发送失败');
        assert.equal(result.getCode(), 500);
        assert.equal(result.getData(), null);
    });

    it('不可变值对象：属性与原型均被冻结，实例互不干扰', () => {
        const result = FuncResult.ok('x');
        assert.throws(() => {
            result.success = false;
        }, TypeError);
        assert.throws(() => {
            // @ts-expect-error 故意新增属性验证冻结
            result.extra = 1;
        }, TypeError);
        assert.equal(FuncResult.ok('y').isSuccess(), true);
        assert.notEqual(FuncResult.ok('z'), result);
    });
});
