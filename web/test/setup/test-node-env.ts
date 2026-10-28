/**
 * `bun test` 本来会把 NODE_ENV 设为 "test"，但这一步只在外部环境没有
 * NODE_ENV 时才生效。宿主（CI/编辑器/本地 shell）继承来的 NODE_ENV=production
 * 会让 `react` 解析到 cjs/react.production.js —— 该构建不导出 `act`，
 * 于是原生 DOM + act 的 React 集成测试全部报 "act is not a function"。
 *
 * 这个预加载脚本（见 web/bunfig.toml 的 [test].preload）在测试模块加载前
 * 把环境恢复成 bun 的默认测试语义，仅作用于 `bun test`，不影响 vite 构建。
 */
process.env.NODE_ENV = "test";
