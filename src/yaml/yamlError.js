/**
 * @fileoverview YAML 错误类型
 *
 * 解析 / 序列化失败的统一错误类型：只携带"类别 + 位置"，不携带源文本片段或值本身。
 *
 * 为什么不含源文本：本库是宿主进程里的共用库，错误对象常被上层 catch 后直接写进
 * 共享日志（与 config.js 同一脱敏纪律）。YAML 文件里通常是口令、密钥，
 * 把出错的原文片段塞进 message 等于把它们抄进日志与 stdout。
 * 需要上下文时请由调用方自己在受控终端里打印输入，而不是让库把文件内容写进日志。
 *
 * 与常见 YAML 库（js-yaml / yaml）的报错体验因此不同：这里给"第几行第几列 + 固定原因"，
 * 不给带引号的原文摘录。
 */

/**
 * 错误类别
 *
 * - `stream`：输入字符集层面（非法控制字符、孤立代理项）；
 * - `scan`：扫描阶段（缩进、引号、指令、块标量指示符、锚点/标签写法）；
 * - `parse`：语法阶段（token 组合不构成合法节点）；
 * - `compose`：合成阶段（别名未定义 / 前向引用、标签未解析、别名超限、深度超限）；
 * - `construct`：构造阶段（重复键、非法 base64 / 时间戳、非标量键等）；
 * - `stringify`：序列化阶段（不可写出的值）；
 * - `file`：文件读取阶段（不存在、无权限、UTF-16 编码）。
 *
 * @typedef {'stream'|'scan'|'parse'|'compose'|'construct'|'stringify'|'file'} YamlErrorKind
 */

/**
 * 错误位置
 *
 * 解析类错误带 line / column / offset；`stringify` 阶段带 path（值在图中的路径）；
 * 文件类错误带 file。
 *
 * @typedef {object} YamlErrorPosition
 * @property {number|null} [line] 行号（1 起）
 * @property {number|null} [column] 列号（1 起）
 * @property {number|null} [offset] 字符偏移（0 起，按归一化后的文本计）
 * @property {string|null} [file] 文件绝对路径
 * @property {Array<string|number>|null} [path] 序列化路径（如 `['a', 0]`）
 */

/**
 * 序列化路径转可读文本
 *
 * @param {Array<string|number>} path 序列化路径
 * @returns {string} 形如 `$.a[0]` 的文本
 */
function formatPath(path) {
    let text = '$';
    for (const segment of path) {
        text += typeof segment === 'number'
            ? `[${segment}]`
            : (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`);
    }
    return text;
}

/**
 * 拼装错误消息
 *
 * 只允许使用固定原因文案（调用方传入）与位置信息；任何业务数据都不得进入 message。
 *
 * @param {YamlErrorKind} kind 错误类别
 * @param {string} reason 固定失败原因（不含源文本与值）
 * @param {YamlErrorPosition|null} position 位置信息
 * @returns {string} 错误消息
 */
function buildMessage(kind, reason, position) {
    const pos = position ?? {};
    if (kind === 'stringify') {
        const where = pos.path ? `（路径 ${formatPath(pos.path)}）` : '';
        return `YAML 序列化失败${where}：${reason}`;
    }
    if (kind === 'file') {
        return `YAML 文件读取失败（${pos.file ?? '未知路径'}）：${reason}`;
    }
    const where = pos.file ? `${pos.file}：` : '';
    const at = typeof pos.line === 'number' && typeof pos.column === 'number'
        ? `第 ${pos.line} 行第 ${pos.column} 列`
        : '位置未知';
    return `${where}YAML 解析失败（${at}）：${reason}`;
}

/**
 * YAML 错误
 *
 * 契约摘要：`kind` 给出失败阶段，`line` / `column` / `offset` / `file` / `path` 给出定位，
 * `message` 只含位置与固定原因，绝不包含源文本片段或值本身。
 *
 * 常用入口：`typeof err.kind === 'string'` 判定阶段；`instanceof YamlError` 判定类型。
 */
export class YamlError extends Error {
    /**
     * @default position = null
     * @param {YamlErrorKind} kind 错误类别
     * @param {string} reason 固定失败原因（不含源文本与值）
     * @param {YamlErrorPosition|null} [position] 位置信息
     */
    constructor(kind, reason, position = null) {
        super(buildMessage(kind, reason, position));

        /** @type {string} */
        this.name = 'YamlError';
        /** @type {YamlErrorKind} */
        this.kind = kind;
        /** @type {string} */
        this.reason = reason;
        /** @type {number|null} */
        this.line = typeof position?.line === 'number' ? position.line : null;
        /** @type {number|null} */
        this.column = typeof position?.column === 'number' ? position.column : null;
        /** @type {number|null} */
        this.offset = typeof position?.offset === 'number' ? position.offset : null;
        /** @type {string|null} */
        this.file = position?.file ?? null;
        /** @type {Array<string|number>|null} */
        this.path = position?.path ?? null;
    }
}
