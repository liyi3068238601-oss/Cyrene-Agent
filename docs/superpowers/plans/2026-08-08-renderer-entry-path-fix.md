# 窗口页面路径故障修复施工记录

## 现象

同步官方 `master@196b0b8` 后启动，Electron 报告 `ERR_FILE_NOT_FOUND`，尝试读取：

- `dist/main/renderer/index.html`
- `dist/main/renderer/react/index.html`
- `dist/main/renderer/sidebar/index.html`

实际构建产物位于 `dist/renderer/`。

## 根因

官方重构把窗口创建代码从 `src/main/index.ts` 拆进了更深一层的：

- `src/main/startup/create-main-window.ts`
- `src/main/windows/create-aux-windows.ts`

代码仍使用重构前的 `__dirname/../../renderer`。编译后这两个模块分别位于 `dist/main/main/startup/` 和 `dist/main/main/windows/`，原相对路径因此少向上一级，错误落到 `dist/main/renderer/`。

## 修复

- 所有生产窗口页面统一从 `app.getAppPath()/dist/renderer/` 定位，不再依赖源码文件嵌套深度。
- 覆盖主桌宠、React 聊天、侧栏、任务、设置、表情管理和通话窗口，共 7 个入口。
- 新增 `renderer-entry-path.test.ts`，禁止窗口工厂重新使用脆弱的 `__dirname` 相对路径。

## TDD 与验证

1. 新测试先失败，准确指出 `create-main-window.ts` 仍使用 `__dirname`。
2. 修改路径后，针对性测试 1/1 通过。
3. `npm run build:main` 通过，编译产物的 7 个入口均包含 `app.getAppPath()/dist/renderer`。
4. 首次完整测试使用真实用户目录时，Cline PoC 的 2 项测试因测试数据库只读失败；改用隔离用户目录后，这 6 项测试全部通过，确认与本修复无关。
5. 隔离目录下完整测试：276 个测试文件通过、1 个跳过；2439 个测试通过、12 个跳过。

## 用户现场保护

同步前已有的以下构建现场未纳入本次提交：

- `dist/renderer/react/index.html`
- `dist/renderer/novelai/`
