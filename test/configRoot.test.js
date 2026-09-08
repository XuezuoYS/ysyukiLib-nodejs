import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { Config } from '#YukiLib/config';

/**
 * 宿主项目根解析优先级测试
 *
 * 覆盖：显式 setRootDir > 环境变量 YUKI_PROJECT_ROOT > 入口脚本向上探测 > process.cwd()
 * 全部在临时目录中进行，不依赖库自身目录状态。
 */

/** 库入口的 file URL（子进程脚本用它 import，避免依赖 node_modules 安装） */
const libEntryUrl = new URL('../src/index.js', import.meta.url).href;

/** 每个用例结束后恢复自动解析与环境变量 */
afterEach(() => {
    Config.setRootDir(null);
    delete process.env.YUKI_PROJECT_ROOT;
});

describe('Config.getRootDir 解析优先级', () => {
    it('显式 setRootDir 优先于环境变量', () => {
        const envDir = mkdtempSync(join(tmpdir(), 'ysyuki-envroot-'));
        const explicitDir = mkdtempSync(join(tmpdir(), 'ysyuki-explicit-'));
        process.env.YUKI_PROJECT_ROOT = envDir;
        Config.setRootDir(explicitDir);
        try {
            assert.equal(Config.getRootDir(), resolve(explicitDir));
        } finally {
            rmSync(envDir, { recursive: true, force: true });
            rmSync(explicitDir, { recursive: true, force: true });
        }
    });

    it('未显式指定时环境变量 YUKI_PROJECT_ROOT 生效', () => {
        const envDir = mkdtempSync(join(tmpdir(), 'ysyuki-envonly-'));
        process.env.YUKI_PROJECT_ROOT = envDir;
        try {
            assert.equal(Config.getRootDir(), resolve(envDir));
        } finally {
            rmSync(envDir, { recursive: true, force: true });
        }
    });

    it('入口脚本向上探测：与 cwd 无关，取最近含 package.json 的目录', () => {
        const projectDir = mkdtempSync(join(tmpdir(), 'ysyuki-entry-'));
        const cwdDir = mkdtempSync(join(tmpdir(), 'ysyuki-cwd-'));
        mkdirSync(join(projectDir, 'src', 'deep'), { recursive: true });
        writeFileSync(join(projectDir, 'package.json'), '{"name":"fixture-host","type":"module"}', 'utf8');
        const script = join(projectDir, 'src', 'deep', 'main.js');
        writeFileSync(
            script,
            `import { Config } from ${JSON.stringify(libEntryUrl)};\nprocess.stdout.write(Config.getRootDir());\n`,
            'utf8',
        );
        try {
            const out = execFileSync(process.execPath, [script], { cwd: cwdDir, encoding: 'utf8' });
            assert.equal(out.trim(), resolve(projectDir));
        } finally {
            rmSync(projectDir, { recursive: true, force: true });
            rmSync(cwdDir, { recursive: true, force: true });
        }
    });

    it('入口信息不可用时回退 process.cwd()', () => {
        const saved = process.argv[1];
        // 故意制造"无入口脚本"场景（node -e / REPL 同语义）
        process.argv.splice(1, 1);
        try {
            assert.equal(Config.getRootDir(), resolve(process.cwd()));
        } finally {
            process.argv[1] = saved;
        }
    });
});
