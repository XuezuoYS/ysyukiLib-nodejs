/**
 * 版本门禁：比较 `package.json` 的 `version` 与仓库最新 `v*` tag，决定要不要打新 tag。
 *
 * 规则（本库 tag 一律 `vMAJOR.MINOR.PATCH`，不支持预发布号）：
 * - 无任何 tag → 打当前版本的 tag（首个版本）；
 * - 当前版本 **严格大于** 最新 tag → 打新 tag；
 * - 相等 → 不打（release 分支上没有新版本的正常状态，工作流仍为绿）；
 * - 小于 → 退出码 1，release 分支不允许版本回退。
 *
 * 输出写入 `--github-output` 指定的文件（`created` / `tag` / `version` / `latestTag` 键值对），
 * 并把人类可读结论追加到 `--summary`（GitHub 步骤摘要）。
 *
 * 用法：`node ci/nextTag.mjs --package-version 0.2.0 --latest-tag v0.1.0 \
 *   --github-output "$GITHUB_OUTPUT" --summary "$GITHUB_STEP_SUMMARY"`
 */

import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

/** 完整版本号：不带预发布号与构建元数据 */
const FULL_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** tag 形态：`v` + 完整版本号，捕获组为版本号本体 */
const TAG_VERSION = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * 比较两个 `MAJOR.MINOR.PATCH` 版本号
 *
 * @param {string} left 左侧版本号
 * @param {string} right 右侧版本号
 * @returns {number} 大于返回 1，等于返回 0，小于返回 -1
 */
function compareVersions(left, right) {
    const a = left.split('.').map(Number);
    const b = right.split('.').map(Number);
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) {
            return a[i] > b[i] ? 1 : -1;
        }
    }
    return 0;
}

/**
 * 把键值对写入 GITHUB_OUTPUT 风格的文件
 *
 * @default summary = ''
 * @param {string} filePath 目标文件路径，空串表示跳过
 * @param {Record<string, string>} values 待写入的键值对
 * @returns {void}
 */
function writeKeyValueFile(filePath, values) {
    if (filePath === '') {
        return;
    }
    const body = Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join('');
    appendFileSync(filePath, body, 'utf8');
}

/**
 * 主流程
 *
 * @param {string[]} argv 进程参数（不含 node 与脚本路径）
 * @returns {number} 退出码
 */
function main(argv) {
    const { values } = parseArgs({
        args: argv,
        options: {
            'package-version': { type: 'string' },
            'latest-tag': { type: 'string' },
            'github-output': { type: 'string' },
            summary: { type: 'string' },
        },
        strict: true,
    });

    const version = String(values['package-version'] ?? '');
    const latestTag = String(values['latest-tag'] ?? '');
    const githubOutput = String(values['github-output'] ?? '');
    const summaryPath = String(values['summary'] ?? '');

    if (!FULL_VERSION.test(version)) {
        process.stderr.write(
            `package.json 的 version "${version}" 不是 MAJOR.MINOR.PATCH（不带预发布号），无法与 tag 比较\n`,
        );
        return 1;
    }

    /** @type {string} */
    let latestVersion = '';
    if (latestTag !== '') {
        const matched = TAG_VERSION.exec(latestTag);
        if (matched === null) {
            process.stderr.write(`最新 tag "${latestTag}" 不是 vMAJOR.MINOR.PATCH 形态，无法比较\n`);
            return 1;
        }
        // matched[0] 形如 v0.1.0，去掉前导 v 才是版本号（捕获组只有主版本号，别误用）
        latestVersion = matched[0].slice(1);
    }

    const nextTag = `v${version}`;
    let created;
    let detail;

    if (latestVersion === '') {
        created = true;
        detail = `仓库还没有 v* tag，按当前版本打首个 tag ${nextTag}`;
    } else {
        const order = compareVersions(version, latestVersion);
        if (order > 0) {
            created = true;
            detail = `当前版本 ${version} 大于最新 tag ${latestTag}（${latestVersion}），打新 tag ${nextTag}`;
        } else if (order === 0) {
            created = false;
            detail = `当前版本 ${version} 等于最新 tag ${latestTag}，无需打 tag（要发新版请先改 package.json 的 version）`;
        } else {
            process.stderr.write(
                `当前版本 ${version} 低于最新 tag ${latestTag}（${latestVersion}）：release 分支不允许版本回退\n`,
            );
            return 1;
        }
    }

    writeKeyValueFile(githubOutput, {
        created: created ? 'true' : 'false',
        tag: created ? nextTag : '',
        version,
        latestTag,
    });

    if (summaryPath !== '') {
        const status = created ? `✅ 打 tag \`${nextTag}\`` : '⏸️ 不打 tag';
        appendFileSync(
            summaryPath,
            `### 版本门禁\n\n${status}\n\n`
            + `- package.json version：\`${version}\`\n`
            + `- 最新 tag：\`${latestTag || '（无）'}\`\n`
            + `- 结论：${detail}\n\n`,
            'utf8',
        );
    }

    process.stdout.write(`${detail}\n`);
    return 0;
}

process.exit(main(process.argv.slice(2)));
