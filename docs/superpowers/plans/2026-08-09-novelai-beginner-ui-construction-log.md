# NovelAI 初学者界面施工记录

日期：2026-08-09

## 本轮最终审查修复

- 修复结果页“使用当前设置再次绘制”只载入参数、不提交生成的问题。普通生成和再次绘制现在共用 `bindGenerationFlow` 提交流程；再次绘制先载入当前结果参数，再执行本地校验、配置持久化和生成请求。重复绑定会先清理旧监听器。
- 为素材库与设置页新增页面内 `aria-live` 状态区和默认折叠的技术详情。角色档案、衣柜、配置保存和连接测试的成功/失败都显示在当前页面；设置失败同步顶部连接 badge；创作页状态和独立素材错误状态不会被清空。
- 任务状态栏优先显示运行中/排队任务；没有活动任务时只读取任务数组第 1 项。`ImageTaskQueue.enqueue()` 使用 `unshift`，因此该项是最新任务。失败摘要使用固定短文案，原始 `task.error` 只保留在展开后的任务行；Prompt 摘要按 Unicode 字符安全截断。
- 将协议支持、参考图、mask 与 outpaint 准备/尺寸检查移到生成请求的错误处理之外。本地校验保留具体提示且不展开任务抽屉；配置持久化失败也不展开；只有生成请求拒绝和任务重试拒绝会展开抽屉并显示“绘图提交失败”及折叠技术详情。
- 加深 muted、accent、accent-strong、success 与 danger 色值；主按钮白字、10–13px 辅助文字以及 danger 在 soft surface 上均满足 WCAG AA。焦点环改为不透明高对比色，素材卡、历史卡、下载动作和隐藏 radio 都有清晰键盘焦点。
- 页面标题增加 `tabindex="-1"`；创作页的可聚焦标题位于左侧表单之前。素材库、设置和返回创作的路由点击后，焦点会移动到目标页标题，返回创作后下一次 Tab 到达 `#natural-prompt`，不会跳到右侧画布动作。
- 第三步生成按钮附近新增独立连接警告。连接失败显示固定文案“API 尚未连接”和“进入设置”按钮，连接成功隐藏；按钮复用页面路由并将焦点送到设置页标题。
- 素材复制、参考素材选择与取消选择的反馈改为素材库内可见状态。单参考和多参考模式都先处理已选素材的取消分支，因此 `img2img` 等单参考模式连续点击同一素材会在第二次清空。素材卡采用完整的 `role="button"` + `aria-pressed` 语义，视觉状态与按压状态在即时点击和异步刷新后保持同步，刷新不会清除刚显示的选择反馈。
- 素材卡只在卡片自身收到 Enter/Space 时触发键盘选择，Space 会阻止默认滚动；收藏按钮、分类 select 和删除按钮的冒泡键盘/点击事件不会改变参考选择。

## TDD 与聚焦验证

RED（实现前）：

- `npx.cmd vitest run src/renderer/novelai/generation-flow.test.ts src/renderer/novelai/task-presentation.test.ts src/renderer/novelai/ui-state.test.ts src/renderer/novelai/layout.test.ts src/renderer/novelai/style-contract.test.ts`
- 结果：退出码 1；5 个测试文件失败。失败覆盖缺少生成/任务呈现模块、再次绘制未生成、路由焦点仍在 `body`、utility status 不存在、旧色值对比度仅 3.87、无不透明 focus token。
- 自查追加 RED：`npx.cmd vitest run src/renderer/novelai/generation-flow.test.ts` 退出码 1，证明旧 `.error` 类会污染后续状态；修复后 4 项通过。
- 最终复审追加 RED：`npx.cmd vitest run src/renderer/novelai/navigation-focus.test.ts` 退出码 1，2 项均失败；旧 DOM 顺序的下一 Tab 到达 `#copy-final-prompt`，并且缺少创建页连接警告行为。
- 同轮组合 RED 中，素材选择同步函数尚不存在，danger/soft surface 计算对比度为 4.451，低于 4.5。测试装载路径修正属于测试夹具修正；随后在未改生产代码前单独重跑导航测试，仍得到上述 2 项有效失败。
- 本轮素材选择 RED：新模块完成装载后，`npx.cmd vitest run src/renderer/novelai/asset-selection.test.ts` 退出码 1，5 项中 4 项按预期失败；失败分别证明单参考第二次点击未清空、缺少 button/pressed 语义、Space 未阻止滚动，以及子控件冒泡导致 9 次错误激活。多参考既有行为测试通过。

GREEN（实现后）：

| 命令 | 退出码 | 实际结果 |
| --- | ---: | --- |
| `npx.cmd vitest run src/renderer/novelai/generation-flow.test.ts src/renderer/novelai/task-presentation.test.ts src/renderer/novelai/ui-state.test.ts src/renderer/novelai/layout.test.ts src/renderer/novelai/style-contract.test.ts` | 0 | 5 个测试文件、36 项测试通过。 |
| `npx.cmd vitest run src/renderer/novelai/navigation-focus.test.ts src/renderer/novelai/ui-state.test.ts src/renderer/novelai/style-contract.test.ts src/renderer/novelai/layout.test.ts` | 0 | 4 个测试文件、32 项测试通过。 |
| `npx.cmd vitest run src/renderer/novelai/asset-selection.test.ts src/renderer/novelai/ui-state.test.ts` | 0 | 2 个测试文件、15 项测试通过。 |
| `npx.cmd vitest run src/plugins/novelai src/renderer/novelai` | 0 | 本轮修复后 14 个测试文件、65 项测试通过。 |
| `npm.cmd run build:renderer` | 0 | 本轮修复后 Vite 转换 8625 个模块并完成构建；仅有既有的大 chunk 警告。 |
| `npm.cmd test` | 0 | 主控制器在最终修复提交 `383b0f9` 后验证：283 个测试文件通过、1 个跳过；2483 项测试通过、12 项跳过；耗时 154.98 秒。 |
| `npm.cmd run build` | 0 | 主控制器在最终修复提交 `383b0f9` 后验证：`build:skills`、`build:main`、`build:preload`、`build:cli`、`build:renderer` 全部成功；renderer 转换 8625 个模块。仅有既有 Vite >500 kB chunk 警告。 |

以上是真正最终的全量证据，由主控制器在 HEAD `383b0f9` 后实际执行并回传。本轮素材修复前的历史阶段 `6594a37` 曾通过 282 个测试文件（另 1 个跳过）、2478 项测试（另 12 项跳过）及完整构建（renderer 8624 个模块）；该组数字仅保留为阶段记录，不代表最终验证结果。

## 行为测试覆盖

- jsdom 点击“使用当前设置再次绘制”，验证顺序为载参 → 校验 → 保存 → generate → 完成回调；重复绑定只生成一次。
- jsdom 本地校验失败，验证具体提示可见、generate 未调用、任务抽屉保持折叠且无技术详情泄露。
- jsdom 生成请求拒绝，验证抽屉展开、固定失败摘要和原始错误详情。
- 任务摘要验证“旧失败、最新成功”、活动任务优先、固定失败短文案和 Unicode 安全截断。
- jsdom 验证素材库/设置页反馈在当前页可见、技术详情默认折叠、素材错误与创作状态独立、设置失败 badge 同步。
- jsdom 从真实 `index.html` 执行路由点击，验证返回创作后的 `document.activeElement` 是位于表单之前的创作页标题，并按实际 DOM 顺序确认下一可 Tab 元素为 `#natural-prompt`。
- jsdom 验证创建页 API 警告在失败时显示固定文案、成功时隐藏，并实际点击“进入设置”确认路由和设置页标题焦点。
- jsdom 直接执行生产选择模块，验证 `img2img` 单参考同一素材连续两次为选中后清空，并验证 `vibe` 多参考追加/取消不回归；素材库内 `aria-live` 会在清空时显示“已清空参考素材”。
- jsdom 验证素材卡 `.is-selected`、`role="button"` 与 `aria-pressed` 同步，卡片 Space 会阻止默认滚动；收藏按钮、分类 select、删除按钮的 Enter/Space/点击冒泡均不会激活卡片，普通卡片内容点击仍会选择。
- 样式测试解析 CSS 色值并计算相对亮度/对比度，不以变量名存在性代替 WCAG 验证；danger `#b04f4f` 在实际 soft surface `#fbf6ee` 上的对比度约为 4.79:1。

## 仍待实机确认

- 真实 Electron 中使用鼠标与完整 Tab 顺序走查三页切换、素材卡焦点、状态播报和 900px 左右窗口布局。
- 使用真实 NovelAI 凭据确认生成、任务重试、连接失败响应、outpaint 解码/尺寸错误和系统文件对话框。
- 核对深色系统主题或宿主主题覆盖下的最终视觉体感；本轮固定色值对暖白主题的计算对比度已自动验证。
- `dist/renderer/react/index.html` 与 `dist/renderer/novelai/` 是本地构建产物，仅保留在工作区，不纳入提交。
