import { existsSync, readFileSync } from 'node:fs';
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
 *
 */

/**
 * 环境变量键名：显式指定宿主项目根目录
 * @type {string}
 */
const ROOT_ENV_KEY = 'YUKI_PROJECT_ROOT';

/**
 * 去除 UTF-8 BOM
 *
 * Windows 记事本、PowerShell 5.1 等写出的 JSON 常带 BOM，
 * 而 JSON.parse 不接受行首 BOM（会静默解析失败）；
 * 作为通用库在此统一剥离，避免"文件明明存在却取值全为 false"。
 *
 * @param {string} text 文件内容
 * @returns {string} 去 BOM 后的内容
 */
function stripBom(text) {
    return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
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
     * @returns {boolean} 恒返回 true（文件缺失时按已确认决策忽略，环境变量仍可由系统环境提供）
     */
    static envRead() {
        if (Config.isEnvLoaded) {
            return true;
        }

        try {
            process.loadEnvFile(Config.resolveFromRoot('.env'));
        } catch {
            // .env 不存在或不可读：忽略（生产环境全部由系统环境提供）
        }

        Config.isEnvLoaded = true;
        return true;
    }

    /**
     * 读取 config.json 文件的内容并转换为对象
     *
     * 文件缺失、解析失败，或解析结果不是对象（内容整体是 `null` / 数字 / 字符串等）时
     * 返回 false（调用方静默回退），但会经 Logger.warn 记录一次
     * 警告：`getConfig` 此时一律返回 false，配置实际未生效，静默失败最难排查。
     * 警告按宿主根去重（setRootDir 重置），重复取值不会刷屏；只记录路径与原因，
     * 不输出文件内容（避免把密钥写进日志）。
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
            Config.#warnConfigUnavailable(file, err);
            return false;
        }

        /** @type {any} */
        let parsed;
        try {
            parsed = JSON.parse(stripBom(content));
        } catch (err) {
            Config.#warnConfigUnavailable(file, err);
            return false;
        }

        if (!isKeyableObject(parsed)) {
            // JSON.parse 成功但内容不是配置对象（如整个文件就是 `null`）：
            // 与解析失败同等处理，否则后续按键取值会抛 TypeError
            Config.#warnConfigUnavailable(file, new TypeError(
                `config.json 内容不是对象（实际为 ${parsed === null ? 'null' : typeof parsed}）`,
            ));
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
     * @param {string} file 配置文件绝对路径
     * @param {any} err 失败原因
     */
    static #warnConfigUnavailable(file, err) {
        if (Config.#hasWarnedConfig) {
            return;
        }
        Config.#hasWarnedConfig = true;

        const missing = err !== null && typeof err === 'object' && /** @type {any} */ (err).code === 'ENOENT';
        Logger.warn(missing ? 'config.json 不存在，Config.getConfig 将一律返回 false' : 'config.json 读取或解析失败，Config.getConfig 将一律返回 false', {
            file,
            reason: err instanceof Error ? err.message : String(err),
        });
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
