import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import { Logger } from './logger.js';

/**
 * 读取配置功能库
 *
 * 使用 Config.getEnv(key) 获取环境变量（系统环境 + `.env` 文件，系统环境优先）
 *
 * 使用 Config.getConfig(key) 获取 config.json 文件中的配置项；
 * 文件缺失、解析失败，或解析结果不是对象（文件内容整体是 null / 数字 / 字符串等）时，
 * getConfig 一律返回 false，并**经 Logger.warn 记录一次**警告
 * （同一宿主根只告警一次；静默失败会让人误以为"配置生效了"）。
 * 该警告只记录路径与脱敏后的失败类别，绝不记录异常 message 或文件内容（防密钥入日志）。
 * 任何情况下 getConfig 都不因配置数据形态而抛 TypeError。
 *
 * 开发环境：宿主项目根存在 `dev.config.json`（不入库）时 Config.isDev() 为 true，
 * 取值优先级：dev.config.json[name] > config.json[`${name}.dev`] > config.json[name]；
 * dev 文件缺失/解析失败/内容不是对象时静默回退普通取值。
 *
 * 宿主项目根（"根目录"）解析优先级（首次调用时确定并缓存）：
 * 1. Config.setRootDir(dir) 显式指定；
 * 2. 环境变量 `YUKI_PROJECT_ROOT`；
 * 3. 入口脚本 `process.argv[1]` 所在目录向上最近的含 package.json 的目录；
 * 4. `process.cwd()`。
 *
 * 作为通用库，本库不假定自身文件位置即宿主位置；应用内所有相对路径
 * （`.env`、`config.json`、`dev.config.json`、`CA/cacert.pem`、邮件模板、日志目录）
 * 一律经 Config.resolveFromRoot(...) 基于宿主项目根解析。
 *
 * 全部方法为静态，配置在首次调用时懒加载并在进程生命周期内缓存；
 * 项目为常驻进程，缓存跨请求有效。setRootDir() 会重置根目录缓存、配置缓存与
 * "已告警"标记（切换宿主根后重新评估是否需要告警）。
 *
 * `.env` 用 `process.loadEnvFile()` 原生加载（Node 20.6+），
 * 其语义为"已存在的 `process.env` 键不被覆盖"，即系统环境变量优先，文件缺失时忽略；
 * 生产环境全部由 Windows 系统/服务环境提供，不依赖 `.env`。
 * 该原生解析器不剥离 UTF-8 BOM（会把 BOM 并入首个键名），故加载后统一修正，
 * 与 `config.json` / `dev.config.json` 的 BOM 容忍保持同一威胁模型；
 * BOM 导致首行整行不被识别的形态（`export KEY=` / 缩进）无法修正，改为 Logger.warn 告警一次；
 * UTF-16 编码的 `.env` 不支持（Node 按 UTF-8 读，失效形态是整个文件全键取不到）。
 *
 */

/**
 * 环境变量键名：显式指定宿主项目根目录
 * @type {string}
 */
const ROOT_ENV_KEY = 'YUKI_PROJECT_ROOT';

/**
 * 去除 UTF-8 BOM（JSON 文本）
 *
 * Windows 记事本、PowerShell 5.1 等写出的 JSON 常带 BOM，
 * 而 JSON.parse 不接受行首 BOM（会静默解析失败）；
 * 作为通用库在此统一剥离，避免"文件明明存在却取值全为 false"。
 *
 * `.env` 的同一威胁模型见 {@link repairBomEnvKeys}：它走原生
 * `process.loadEnvFile()`，无法在解析前剥离 BOM，只能加载后修正被写坏的键名。
 *
 * @param {string} text 文件内容
 * @returns {string} 去 BOM 后的内容
 */
function stripBom(text) {
    return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

/**
 * 修复 `.env` 带 UTF-8 BOM 时被写坏的首个键
 *
 * 与 {@link stripBom} 同一个威胁模型（Windows 记事本、PowerShell 5.1
 * `Set-Content -Encoding UTF8`），但 `.env` 由原生 `process.loadEnvFile()` 解析，
 * 调用方碰不到它解析前的文本；Node 也不剥离 BOM —— 解码后的 U+FEFF 会并入第一行的
 * 键名，于是 `KEY=value` 变成 `"\uFEFFKEY"=value`：按正常键名取值静默得到 undefined
 * （同文件的其余键全部正常，现象最迷惑）。这里在加载后把坏键改回正常名并删除，
 * 避免宿主再把它继承给子进程。
 *
 * 两条约束：
 * 1. 只处理 `before` 之后新增的 BOM 键——宿主进程继承来的环境一律不动；
 * 2. 正常名已能取到值时不覆盖（维持"系统环境变量优先于 `.env`"），只删坏键。
 *    `loadEnvFile` 的"已存在键不覆盖"检查是对**坏键名**做的，所以文件值确实会以坏键名
 *    落进 `process.env`，修复若一味改名就会把文件值盖到系统值上。
 *
 * 只能修"键名被 BOM 污染"这一种形态：BOM 之后紧跟 `export ` 或缩进时
 * （`"\uFEFFexport KEY=v"`、`"\uFEFF  KEY=v"`），整行在 Node 的解析里就不匹配，
 * 值根本没进过 `process.env`，无从改名恢复；该形态改由 {@link Config.#warnBomFirstLineLost}
 * 告警一次（见 `envRead`），而不是假装修好了。
 *
 * @param {Set<string>} before 加载前已存在的 BOM 前缀键名集合
 * @returns {void}
 */
function repairBomEnvKeys(before) {
    for (const key of Object.keys(process.env)) {
        if (key.charCodeAt(0) !== 0xFEFF || before.has(key)) {
            continue;
        }
        const cleanKey = key.slice(1);
        const value = process.env[key];
        if (cleanKey !== '' && value !== undefined && process.env[cleanKey] === undefined) {
            process.env[cleanKey] = value;
        }
        delete process.env[key];
    }
}

/**
 * 取带 BOM 的 `.env` 首行的键名
 *
 * 用于 {@link Config.envRead} 判断"首行被原生解析器整行丢弃"这一种 BOM 形态：
 * 此时值根本没进过 `process.env`，本库无从改名恢复（本库不接管 `.env` 的解析），
 * 但至少要把这声"文件明明存在却少一个键"说出来，而不是继续静默。
 *
 * 只读文件头部若干字节，且返回值只用作**存在性判断**：键名本身绝不写进日志
 * （键名也是文件内容，与 `#warnConfigUnavailable` 同一脱敏纪律）。
 * 无 BOM、文件读不到、首行不是赋值形态或键名超出读取范围时返回 null（宁可漏告警，不误告警）。
 *
 * @param {string} file `.env` 绝对路径
 * @returns {string|null} 首行赋值形态的键名，否则 null
 */
function detectBomFirstEnvKey(file) {
    /** @type {number|undefined} */
    let fd;
    try {
        fd = openSync(file, 'r');
        const head = Buffer.alloc(1024);
        // 注意实参顺序：fs.readSync(fd, buffer, offset, length, position)
        const bytes = readSync(fd, head, 0, head.length, 0);
        const text = head.subarray(0, bytes).toString('utf8');
        if (text.charCodeAt(0) !== 0xFEFF) {
            return null;
        }
        const newLine = text.indexOf('\n', 1);
        const firstLine = newLine === -1 ? text.slice(1) : text.slice(1, newLine);
        const matched = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/.exec(firstLine);
        return matched === null ? null : matched[1];
    } catch {
        // 文件不存在 / 不可读 / 不是普通文件：由 loadEnvFile 那条路径统一按"忽略"处理
        return null;
    } finally {
        if (fd !== undefined) {
            closeSync(fd);
        }
    }
}

/**
 * 判断解析结果是否可按键取值
 *
 * `config.json` 内容整体是 `null`（或数字 / 字符串 / 布尔等 JSON 值）时，
 * `JSON.parse` 依然**成功**并返回非对象值；此时按键取值会抛
 * `TypeError: Cannot convert undefined or null to object`，
 * 与"缺失 / 失败一律返回 false"的容错承诺相悖。
 * 统一以本函数判定：不是对象即视为"配置不可用"，不抛错。
 *
 * 数组是对象，故顶层数组仍可按下标取值（维持既有行为，按键取不到时返回 false）。
 *
 * @param {any} data 解析得到的配置数据
 * @returns {boolean} 可按键取值返回 true
 */
function isKeyableObject(data) {
    return data !== null && typeof data === 'object';
}

/**
 * 从入口脚本路径向上探测宿主项目根（最近的含 package.json 的目录）
 *
 * 入口为 node 自身（`--test`/`--eval` 等场景）或探测不到时返回 null。
 *
 * @param {string|undefined} entry 入口脚本路径（process.argv[1]）
 * @returns {string|null} 根目录绝对路径（无尾分隔符），探测失败返回 null
 */
function detectRootFromEntry(entry) {
    if (typeof entry !== 'string' || entry === '') {
        return null;
    }

    let dir = dirname(resolve(entry));

    // node 安装目录（--test 的内部入口等）不作为候选
    if (dir.toLowerCase().startsWith(dirname(process.execPath).toLowerCase())) {
        return null;
    }

    for (;;) {
        if (existsSync(join(dir, 'package.json'))) {
            return dir;
        }
        const parent = dirname(dir);
        if (parent === dir) {
            return null;
        }
        dir = parent;
    }
}

export class Config {
    /**
     * 标记 .env 是否已经被加载
     * @type {boolean}
     */
    static isEnvLoaded = false;

    /**
     * 标记 config.json 是否已经被加载
     * @type {boolean}
     */
    static isConfigLoaded = false;

    /**
     * 配置文件集合，需运行 configRead() 获取
     *
     * 本库只在解析结果是对象时写入（读取失败保持 `{}`）；
     * 外部赋成非对象时 getConfig 按"不可用"处理（返回 false，不抛错）。
     *
     * @type {Record<string, any>}
     */
    static configData = {};

    /**
     * 标记 dev.config.json 是否已经被加载
     * @type {boolean}
     */
    static isDevConfigLoaded = false;

    /**
     * 开发环境配置集合，需运行 devConfigRead() 获取
     *
     * 同 configData：本库只在解析结果是对象时写入，非对象一律按"不可用"回退普通取值。
     *
     * @type {Record<string, any>}
     */
    static devConfigData = {};

    /**
     * 显式指定的宿主项目根目录（null 表示按优先级自动解析）
     * @type {string|null}
     */
    static #rootDir = null;

    /**
     * 自动解析结果缓存（不含显式指定值）
     * @type {string|null}
     */
    static #detectedRootDir = null;

    /**
     * 显式指定的开发环境配置文件路径（null 表示取宿主根下 dev.config.json）
     * @type {string|null}
     */
    static #devConfigFile = null;

    /**
     * 是否已就"config.json 不可用"告警过（每次 setRootDir 重置）
     * @type {boolean}
     */
    static #hasWarnedConfig = false;

    /**
     * 显式指定宿主项目根目录（测试、非标准部署目录等场景）
     *
     * 会重置根目录缓存、配置缓存与 devConfigFile 显式指定值，
     * 使后续取值全部基于新的根目录；传 null 恢复自动解析。
     *
     * @param {string|null} [dir] 根目录绝对路径；null 表示恢复自动解析
     * @default dir = null
     * @returns {void}
     */
    static setRootDir(dir = null) {
        Config.#rootDir = dir === null || dir === undefined ? null : resolve(String(dir));
        Config.#detectedRootDir = null;
        Config.#devConfigFile = null;
        Config.#hasWarnedConfig = false;
        Logger.resetDevCache();
        Config.isEnvLoaded = false;
        Config.isConfigLoaded = false;
        Config.isDevConfigLoaded = false;
        Config.configData = {};
        Config.devConfigData = {};
    }

    /**
     * 获取宿主项目根目录（绝对路径，无尾分隔符）
     *
     * 优先级见模块说明；结果在首次调用时解析并缓存，
     * 直到 setRootDir() 重置（环境变量与入口脚本在进程内视为不变）。
     *
     * @returns {string} 宿主项目根目录
     */
    static getRootDir() {
        if (Config.#rootDir !== null) {
            return Config.#rootDir;
        }
        if (Config.#detectedRootDir !== null) {
            return Config.#detectedRootDir;
        }

        const fromEnv = process.env[ROOT_ENV_KEY];
        const detected = typeof fromEnv === 'string' && fromEnv !== ''
            ? resolve(fromEnv)
            : (detectRootFromEntry(process.argv[1]) ?? process.cwd());

        Config.#detectedRootDir = detected;
        return detected;
    }

    /**
     * 将宿主项目根相对路径解析为绝对路径
     *
     * 应用内所有相对路径（`.env`、`config.json`、`dev.config.json`、
     * `CA/cacert.pem`、邮件模板、日志目录）一律基于宿主项目根解析。
     *
     * @param {...string} segments 相对路径分段；不传时返回带尾分隔符的根目录
     * @returns {string} 绝对路径
     */
    static resolveFromRoot(...segments) {
        if (segments.length === 0) {
            return Config.getRootDir() + sep;
        }
        return resolve(Config.getRootDir(), ...segments);
    }

    /**
     * 开发环境配置文件路径（默认宿主根下 dev.config.json）
     *
     * 可显式赋值重定向（测试夹具等）；赋值 null 恢复默认解析。
     *
     * @returns {string} 开发环境配置文件绝对路径
     */
    static get devConfigFile() {
        return Config.#devConfigFile ?? Config.resolveFromRoot('dev.config.json');
    }

    /**
     * @param {string|null} file 开发环境配置文件路径
     */
    static set devConfigFile(file) {
        Config.#devConfigFile = file === null ? null : String(file);
        Logger.resetDevCache();
    }

    /**
     * 读取 .env 文件至 process.env（已存在的键不覆盖，即系统环境优先）
     *
     * 带 UTF-8 BOM 的文件（Windows 记事本、PowerShell 5.1 `Set-Content -Encoding UTF8`）
     * 会被原生解析器把 BOM 并入首个键名，故加载后修正，见 {@link repairBomEnvKeys}。
     *
     * 两处原生解析器限制本库无法修正（BOM 只影响第一行，其余行一律正常）：
     * - 首行写作 `export KEY=...` 或键名前带缩进：整行不被原生解析器匹配，值从未进入
     *   `process.env`，无从改名恢复 → 改为经 `Logger.warn` 记录一次（见 {@link Config.#warnBomFirstLineLost}）；
     * - UTF-16 编码的 `.env`：Node 按 UTF-8 读，失效形态是全键取不到而非只丢首键，
     *   本库不识别也不告警（Node 原生 `--env-file` 同样不支持）。
     * 生产环境请由系统/服务环境提供，或把 `.env` 存为"UTF-8（无 BOM）"。
     *
     * @returns {boolean} 恒返回 true（文件缺失时按已确认决策忽略，环境变量仍可由系统环境提供）
     */
    static envRead() {
        if (Config.isEnvLoaded) {
            return true;
        }

        const file = Config.resolveFromRoot('.env');
        // 仅当文件带 BOM 时返回首行键名；先记下系统环境是否已提供该键（已有值就不算丢失）
        const bomFirstKey = detectBomFirstEnvKey(file);
        const providedBySystem = bomFirstKey !== null && process.env[bomFirstKey] !== undefined;

        try {
            // 只修复本次加载引入的 BOM 键，宿主进程继承的环境一律不动
            const bomBefore = new Set(Object.keys(process.env).filter((key) => key.charCodeAt(0) === 0xFEFF));
            process.loadEnvFile(file);
            repairBomEnvKeys(bomBefore);

            if (bomFirstKey !== null && !providedBySystem && process.env[bomFirstKey] === undefined) {
                Config.#warnBomFirstLineLost(file);
            }
        } catch {
            // .env 不存在或不可读：忽略（生产环境全部由系统环境提供）
        }

        Config.isEnvLoaded = true;
        return true;
    }

    /**
     * BOM 吞掉 `.env` 首行时的单次警告
     *
     * 与"文件缺失静默忽略"不冲突：文件确实在、也确实想提供配置，只是首行没被原生解析器认出来，
     * 这种"看着生效其实少一个键"的静默失败正是本库反复声明要避免的形态（见 `#warnConfigUnavailable`）。
     *
     * 记录范围仍是"路径 + 固定文案"：**不记录键名**（键名也是文件内容，与既有脱敏纪律一致），
     * 定位交给"第一行"这个位置信息。每次宿主根加载至多一次（`isEnvLoaded` 缓存，`setRootDir` 重置）。
     *
     * @param {string} file `.env` 绝对路径
     * @returns {void}
     */
    static #warnBomFirstLineLost(file) {
        Logger.warn('.env 首行未被加载，Config.getEnv 对首行的键将返回 false', {
            file,
            reason: '首行为 UTF-8 BOM + export / 缩进赋值形态，Node 原生 process.loadEnvFile 整行不匹配；'
                + '键名与值一律不记录（键名也是文件内容），请把 .env 另存为 UTF-8（无 BOM）或改用系统环境变量',
        });
    }

    /**
     * 读取 config.json 文件的内容并转换为对象
     *
     * 文件缺失、解析失败，或解析结果不是对象（内容整体是 `null` / 数字 / 字符串等）时
     * 返回 false（调用方静默回退），但会经 Logger.warn 记录一次
     * 警告：`getConfig` 此时一律返回 false，配置实际未生效，静默失败最难排查。
     * 警告按宿主根去重（setRootDir 重置），重复取值不会刷屏。
     *
     * 记录范围严格限定为"路径 + 脱敏原因"：原因只到错误类别（errno 码、`SyntaxError`、
     * 顶层值类型）为止，**绝不使用异常的 `message`**——`JSON.parse` 的 SyntaxError 消息
     * 会内嵌文件原文片段，等于把 config.json 里的口令抄进 stdout 与日志文件
     * （见 {@link Config.#parseFailureReason} 的注释）。需要精确行列时，请在受控终端里
     * 自行用 node 复现一次解析，而不是让库把文件内容写进共享日志。
     *
     * @returns {boolean} 读取成功返回 true，失败返回 false
     */
    static configRead() {
        if (Config.isConfigLoaded) {
            return true;
        }

        const file = Config.resolveFromRoot('config.json');

        let content;
        try {
            content = readFileSync(file, 'utf8');
        } catch (err) {
            // 只取 errno 码（ENOENT / EACCES / EISDIR …）：其 message 里除路径外没有更多信息，
            // 而路径已经由 file 字段单独记录
            const code = Config.#errorLabel(err);
            Config.#warnConfigUnavailable(file, code, code === 'ENOENT');
            return false;
        }

        /** @type {any} */
        let parsed;
        try {
            parsed = JSON.parse(stripBom(content));
        } catch (err) {
            Config.#warnConfigUnavailable(file, Config.#parseFailureReason(err));
            return false;
        }

        if (!isKeyableObject(parsed)) {
            // JSON.parse 成功但内容不是配置对象（如整个文件就是 `null`）：
            // 与解析失败同等处理，否则后续按键取值会抛 TypeError。
            // 只报顶层类型（typeof），不报值本身——字符串/数字配置文件的值同样可能含密钥。
            Config.#warnConfigUnavailable(file,
                `config.json 内容不是对象（实际为 ${parsed === null ? 'null' : typeof parsed}）`,
            );
            return false;
        }

        Config.configData = parsed;
        Config.isConfigLoaded = true;
        return true;
    }

    /**
     * config.json 不可用时的单次警告
     *
     * 同一次解析（同一宿主根）只告警一次：`isConfigLoaded` 在失败时保持 false，
     * 每次 getConfig 都会重试读取，不去重会随取值次数刷屏。
     *
     * `reason` 必须是调用方已经确认**不含文件内容**的文本（errno 码、固定文案、typeof），
     * 不得再把异常的 `message` 直接传进来：见 {@link Config.#parseFailureReason}。
     *
     * @param {string} file 配置文件绝对路径
     * @param {string} reason 脱敏后的失败原因
     * @param {boolean} [missing] 是否为"文件不存在"（决定告警文案）
     * @default missing = false
     */
    static #warnConfigUnavailable(file, reason, missing = false) {
        if (Config.#hasWarnedConfig) {
            return;
        }
        Config.#hasWarnedConfig = true;

        Logger.warn(missing ? 'config.json 不存在，Config.getConfig 将一律返回 false' : 'config.json 读取或解析失败，Config.getConfig 将一律返回 false', {
            file,
            reason,
        });
    }

    /**
     * 取异常的"可安全记录标识"
     *
     * 只用 errno `code`（ENOENT / EACCES / EISDIR 等）；没有 code 时退化为错误类型名。
     * 二者都与被读出的内容无关，而 `message` 不满足这一点，故这里刻意不去取它。
     * 非 Error 的抛出值只报 `typeof`：不能对未知值调用 `String(err)`（它可能就是内容本身）。
     *
     * @param {any} err 捕获到的异常
     * @returns {string} 错误码，或错误类型名
     */
    static #errorLabel(err) {
        const code = err !== null && typeof err === 'object' ? /** @type {any} */ (err).code : undefined;
        if (typeof code === 'string' && code !== '') {
            return code;
        }
        if (err instanceof Error) {
            return err.name;
        }
        return typeof err;
    }

    /**
     * JSON.parse 失败原因（脱敏）
     *
     * V8 的 SyntaxError 消息会把**出错位置附近的原文片段**放进引号里：
     * ```
     * SyntaxError: Unexpected token 'D', "DB_PASSWOR"... is not valid JSON
     * ```
     * 输入较短时给出的甚至是全文（`Unexpected token '}', "{"a": tru}" is not valid JSON`）。
     * config.json 里通常是数据库口令、第三方密钥，把 message 原样写进 WARN 等于
     * 把密钥同时抄进 stdout 和日志文件，因此整条 message 一律丢弃，只给出固定类别。
     *
     * @param {any} err JSON.parse 抛出的异常
     * @returns {string} 不含文件内容的失败原因
     */
    static #parseFailureReason(err) {
        if (err instanceof SyntaxError) {
            return 'SyntaxError: 不是合法 JSON（原始消息可能含文件内容片段，已省略以免泄漏密钥）';
        }
        // 理论上到不了这里（JSON.parse 只抛 SyntaxError），保留兜底以策安全
        return Config.#errorLabel(err);
    }

    /**
     * 是否开发环境：宿主项目根存在 dev.config.json 文件即为开发环境
     *
     * 实时检查文件存在性（不缓存），允许开发期增删该文件即时切换。
     *
     * @returns {boolean} 存在返回 true，否则 false
     */
    static isDev() {
        return existsSync(Config.devConfigFile);
    }

    /**
     * 读取 dev.config.json 文件的内容并转换为对象
     *
     * 文件缺失、解析失败或内容不是对象时返回 false（调用方静默回退普通取值）；
     * 与 configRead 不同，此处不告警（开发配置本就是可选覆盖）。
     *
     * @returns {boolean} 读取成功返回 true，文件缺失、解析失败或内容不是对象返回 false（调用方静默回退普通取值）
     */
    static devConfigRead() {
        if (Config.isDevConfigLoaded) {
            return true;
        }

        let content;
        try {
            content = readFileSync(Config.devConfigFile, 'utf8');
        } catch {
            return false;
        }

        /** @type {any} */
        let parsed;
        try {
            parsed = JSON.parse(stripBom(content));
        } catch {
            return false;
        }

        if (!isKeyableObject(parsed)) {
            // 内容整体是 `null` 等非对象值：解析"成功"但不可按键取值，静默回退
            return false;
        }

        Config.devConfigData = parsed;
        Config.isDevConfigLoaded = true;
        return true;
    }

    /**
     * 获取环境变量
     *
     * @param {string} key 环境变量键名
     * @returns {string|false} 获取成功返回环境变量值，失败返回 false
     */
    static getEnv(key) {
        Config.envRead();
        const value = process.env[key];
        return value === undefined ? false : value;
    }

    /**
     * 获取配置项
     *
     * 开发环境（dev.config.json 存在且可读）下优先取 dev 文件同名键，
     * 其次取 config.json 的 `${key}.dev` 键，最后回退 config.json 普通键。
     *
     * 配置缓存形态异常（被赋值为 null / 非对象）时同样返回 false，不抛 TypeError。
     *
     * @param {string} key 配置项键名
     * @returns {any|false} 获取成功返回配置项值（可为字符串/数字/布尔/对象），失败返回 false
     */
    static getConfig(key) {
        const success = Config.configRead();
        if (!success || !isKeyableObject(Config.configData)) {
            return false;
        }

        if (Config.isDev() && Config.devConfigRead() && isKeyableObject(Config.devConfigData)) {
            if (Object.prototype.hasOwnProperty.call(Config.devConfigData, key)) {
                return Config.devConfigData[key];
            }
            const devAlias = `${key}.dev`;
            if (Object.prototype.hasOwnProperty.call(Config.configData, devAlias)) {
                return Config.configData[devAlias];
            }
        }

        return Object.prototype.hasOwnProperty.call(Config.configData, key) ? Config.configData[key] : false;
    }
}
