# 上游 master@196b0b8 同步设计

## 目标

把官方 `master@196b0b8` 的 86 个提交完整吸收到 `liyi-Cyrene-v2`，同时保留本地分支已经交付的插件系统、NovelAI 工作台、启动 BAT、兼容性修复和全部施工文档。同步在隔离分支完成，验证通过后才合回并推送。

## 分支关系

```text
origin/master@196b0b8
        ↓ 本地纯净镜像
master@196b0b8
        ↓ merge（在隔离分支解决冲突）
sync/upstream-196b0b8
        ↓ 验证通过后快进合回
liyi-Cyrene-v2
```

`master` 继续保持官方镜像，不接收本地功能提交。同步方向始终是 `master` 合入 `liyi-Cyrene-v2`，不反向合并。

## 合并原则

1. 以 Git 三方合并为基础，不重写双方历史。
2. 上游重构后的模块化结构优先；不得用本地旧版大型 `index.ts` 或 `settings.ts` 整体覆盖上游。
3. 本地功能行为必须完整保留：
   - 插件 manifest、loader、context、manager、storage 和受控 `open()`；
   - 设置页“功能插件”列表、启停和打开按钮；
   - NovelAI 插件、独立 preload、renderer 页面、工具、IPC、任务队列与配置存储；
   - 主模型 `llm.translateText` 白名单注入；
   - `start.bat` 每次启动前完整构建；
   - 现有插件、NAI、启动流程设计和施工文档。
4. 上游新增行为必须保留：DMAE V5.1、L2 Working Memory、Obsidian 同步、Windows watcher 修复、主程序模块化、设置页模块化和 Vitest 稳定性配置。
5. 自动合并成功不等于语义正确；所有双方同时改动的文件都要人工审查。

## 已知冲突与迁移策略

只读 `git merge-tree` 演练确认两个内容冲突：

### `src/main/index.ts`

保留上游拆分后的精简入口和新 bootstrap/service 生命周期，把本地 PluginManager 接线迁移到上游结构中。插件启动仍发生在 `app.whenReady()`，退出时仍调用 `pluginManager.stop()`；LLM 注入继续使用当前模型设置和 `pluginTranslateText`。

如直接放回入口会重新增加耦合，则新增一个小型插件启动模块，只负责组装 PluginManager 运行时依赖、启动、停止和开关持久化；不移动插件框架自身。

### `src/renderer/settings/settings.ts`

保留上游设置页拆分结果。把本地“功能插件”面板逻辑迁成独立模块，沿用上游 `dom.ts` / `panel.ts` 组织方式；中央 `settings.ts` 只保留导航切换所需的最小接线。上游已有的“插件”页实际管理天气、出行和 MCP，不能覆盖；本地“功能插件”作为独立页面继续存在。

## 自动合并审查范围

以下五个双方都改过的文件预计自动合并，仍需逐项检查：

- `package.json`：同时保留上游依赖/脚本变化和本地内置插件 manifest 拷贝步骤。
- `src/preload/index.ts`：保留上游 API，并继续暴露受控 `plugins.list/setEnabled/open`。
- `src/renderer/settings/index.html`：保留上游页面结构和本地“功能插件”导航/面板容器。
- `src/shared/ipc-channels.ts`：保留上游通道和本地 `PLUGINS_LIST/SET_ENABLED/OPEN`。
- `vitest.config.ts`：保留上游 Windows 单进程稳定性配置和本地插件测试收集范围。

## 验证与完成标准

1. 合并完成后不存在冲突标记，工作树只含计划内文件。
2. 对比同步前的本地分支，插件系统、NovelAI、启动 BAT 和施工文档均仍存在。
3. 对比 `master@196b0b8`，上游新增的 memory、settings、services、startup 等模块均存在。
4. 插件专项、NovelAI/LLM 专项、设置页相关测试全部通过。
5. 全量测试无失败，测试数量以合并后的实际结果为准。
6. `npm run build` 通过，并生成：
   - `dist/main/plugins/novelai/manifest.json`
   - `dist/main/plugins/novelai/index.js`
   - `dist/main/plugins/novelai/preload.js`
   - `dist/renderer/novelai/index.html`
7. 构建产物运行时冒烟确认 NovelAI 可启用、可打开、工具和 IPC 注册，停用后资源清零。
8. 施工日志记录合并基点、冲突文件、解决策略、测试/构建结果和提交 hash。
9. 验证通过后合回 `liyi-Cyrene-v2`，推送 `fork/liyi-Cyrene-v2`，清理同步工作树与临时分支。

## 非目标

- 不把 `liyi-Cyrene-v2` 合入 `master`。
- 不顺手重构与冲突无关的模块。
- 不删除或提交主工作树现有的 `dist` 生成物。
- 不在本次同步中处理网易云音乐的 Git PATH 环境提示。
