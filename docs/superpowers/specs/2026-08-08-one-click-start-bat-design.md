# Cyrene 一键启动 BAT 设计

## 目标

让不熟悉 Node.js、npm 和命令行的用户可以直接双击 `start.bat` 启动 Cyrene，并在环境未准备好时看到清楚的中文提示。

## 启动流程

1. BAT 自动切换到自身所在的项目目录，避免从快捷方式或其他目录启动时找不到文件。
2. 检查 `node_modules`。如果不存在，提示用户先双击 `setup.bat`，然后暂停窗口，不自动执行耗时的安装。
3. 检查主程序 `dist/main/main/index.js`。如果不存在，提示用户先双击 `setup.bat` 完成构建，然后暂停窗口。
4. 环境满足后，通过 `call npm.cmd start` 启动 Electron，不依赖全局 `cyrene` 命令或 `npm link`。
5. 如果 npm 不存在或启动返回错误，显示中文错误信息和错误码，并暂停窗口，方便用户截图排查。
6. 正常关闭 Cyrene 后，BAT 窗口直接结束。

## 范围

- 只修改根目录 `start.bat`。
- 不修改 `setup.bat`、npm scripts 或程序源码。
- 不自动安装依赖、不自动重新构建，避免每次启动等待或在用户不知情时修改环境。

## 验证

- 静态检查 BAT 分支和错误处理。
- 在临时目录分别模拟缺少 `node_modules`、缺少构建产物，确认中文提示和退出码。
- 在当前已准备好的项目中验证 BAT 能进入 `npm.cmd start` 启动路径；自动验证时不长时间运行 Electron GUI。
