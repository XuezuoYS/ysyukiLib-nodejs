# 更新日志

## [0.1.1] - 2026-09-10

### Docs

docs: 修复类注释在 IDE 中无法悬浮快捷查看的问题

- `Config`、`Logger`、`HttpClient`、`HttpRes`、`Router`、`HttpServer`、`Middleware`、
  `ServerLogger` 八个类的说明原写在文件头部，与 `export class` 之间隔着 `import`、常量与函数，
  tsserver 只认"紧贴类声明的那一段 JSDoc"，导致宿主项目里悬停类名只剩 `(alias) class X`；
  现每个类补一段**紧贴声明**的类注释（一句话摘要 + 契约摘要 + 常用入口，实测 hover 120–424 字）。
- 文件头长说明原文保留并统一改标 `@fileoverview`（含两个 barrel），类块只留契约摘要、
  长细节留在文件头与 `docs/`，避免 hover 被上千字说明糊满。
- `@typedef` / `@property` 一律拆为独立块（`middleware` / `router` / `server` / `serverLogger`）：
  与类描述同块时整块会被 typedef 认领，类 hover 依旧为空；类型说明改写到各 `@typedef` 行尾
  （块首描述会被当成块内所有类型的说明）。只拆不删，类型定义与 `pnpm check` 诊断数不变。
- 纯注释与文档改动：公共 API、导出形态与运行时行为零变更，`pnpm check` 仍 exit 0、
  `pnpm test` 全量通过；`FuncResult` / `AppError` / `SubLogger` 三个原本就正常的类未改动，
  `HttpReq` 一并把 1518 字的文件头说明拆成 395 字类块 + `@fileoverview`（长细节一字未删）。
- 同版本内的其它文档变更：新增 `docs/httpServer.md`（httpServer 完整行为约定）与
  `docs/migrateFrom.md`（旧 API 迁移对照与破坏性变更清单）；`README.md` 安装与使用章节重构
  （`ci/` 内引用的 README 小节名一并同步）；`AGENTS.md` 固化类注释规范；
  标注 `httpClient` 与 `httpServer` 的非对称关系。
