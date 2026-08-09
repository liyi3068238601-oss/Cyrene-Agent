# NovelAI Beginner-Friendly UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 NovelAI 插件改造成暖白色“专注画布”界面，让新用户按照“描述画面 → 选择角色和服装 → 开始绘制”完成首次生成，同时保留所有现有能力。

**Architecture:** 保留 `main.ts` 中已有的配置、素材、提示词、任务和生成逻辑，只新增一个小型 DOM 界面状态模块负责创作页、素材库、设置页和底部任务抽屉的切换。`index.html` 重新组织信息层级，CSS 改为暖白主题；通过纯 DOM 单元测试和静态结构契约测试降低重排风险。

**Tech Stack:** TypeScript 5.6、原生 HTML/CSS、Vitest 4、jsdom、Vite 7、Electron 43

## Global Constraints

- 只改 NovelAI 插件渲染界面及必要的界面状态连接。
- 不改变生成服务、插件运行协议、任务协议和持久化数据格式。
- 中文描述和翻译后的英文提示词必须同时显示并可编辑。
- 高级设置默认折叠，现有参数、默认值、校验和提交方式保持不变。
- 素材库和设置在同一个 NovelAI 窗口内显示为独立页面，不使用弹窗或新操作系统窗口。
- 页面切换时不得清空当前提示词、角色、服装、参考图或高级参数。
- 底部任务与历史默认折叠，点击状态栏后展开。
- 尽量保留现有 DOM `id`、数据字段和事件路径。
- 不进行与本界面目标无关的大规模重构。
- 不提交 `dist/renderer/react/index.html` 或 `dist/renderer/novelai/`。

---

## File Map

- Create: `src/renderer/novelai/ui-state.ts` — 页面与任务抽屉的显示状态。
- Create: `src/renderer/novelai/ui-state.test.ts` — 页面切换、返回创作和抽屉测试。
- Create: `src/renderer/novelai/layout.test.ts` — 新手流程、低频入口和旧控件保留契约。
- Create: `src/renderer/novelai/style-contract.test.ts` — 暖白主题与响应式契约。
- Modify: `src/renderer/novelai/index.html` — 新页面结构。
- Modify: `src/renderer/novelai/main.ts` — 状态模块、任务摘要和结果下载接线。
- Modify: `src/renderer/novelai/novelai.css` — 暖白主题和主布局。
- Modify: `src/renderer/novelai/wardrobe.css` — 素材相关控件主题适配。
- Create: `docs/superpowers/plans/2026-08-09-novelai-beginner-ui-construction-log.md` — 施工和验证记录。

---

### Task 1: 可测试的页面与抽屉状态控制器

**Files:**
- Create: `src/renderer/novelai/ui-state.ts`
- Create: `src/renderer/novelai/ui-state.test.ts`

**Interfaces:**
- Consumes: `data-nai-route`、`data-nai-page`、`data-return-to-create`、`#activity-toggle`、`#activity-drawer`。
- Produces: `NovelAiPage`、`showNovelAiPage(page, root)`、`setActivityDrawer(open, root)`、`bindNovelAiUi(root)`。

- [ ] **Step 1: 写失败的 DOM 状态测试**

```ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { bindNovelAiUi, setActivityDrawer, showNovelAiPage } from "./ui-state";

beforeEach(() => {
  document.body.innerHTML = `
    <button data-nai-route="create">创作</button>
    <button data-nai-route="library">素材库</button>
    <button data-nai-route="settings">设置</button>
    <button data-return-to-create>返回创作</button>
    <section data-nai-page="create"></section>
    <section data-nai-page="library" hidden></section>
    <section data-nai-page="settings" hidden></section>
    <button id="activity-toggle" aria-expanded="false"></button>
    <section id="activity-drawer" hidden></section>`;
});

describe("NovelAI UI state", () => {
  it("shows exactly the requested page", () => {
    showNovelAiPage("library");
    expect(document.querySelector('[data-nai-page="create"]')?.hasAttribute("hidden")).toBe(true);
    expect(document.querySelector('[data-nai-page="library"]')?.hasAttribute("hidden")).toBe(false);
    expect(document.querySelector('[data-nai-route="library"]')?.classList.contains("is-active")).toBe(true);
  });

  it("returns to the same create node", () => {
    const create = document.querySelector('[data-nai-page="create"]');
    bindNovelAiUi();
    (document.querySelector('[data-nai-route="settings"]') as HTMLButtonElement).click();
    (document.querySelector("[data-return-to-create]") as HTMLButtonElement).click();
    expect(document.querySelector('[data-nai-page="create"]')).toBe(create);
    expect(create?.hasAttribute("hidden")).toBe(false);
  });

  it("synchronizes drawer visibility and aria-expanded", () => {
    setActivityDrawer(true);
    expect(document.querySelector("#activity-drawer")?.hasAttribute("hidden")).toBe(false);
    expect(document.querySelector("#activity-toggle")?.getAttribute("aria-expanded")).toBe("true");
    setActivityDrawer(false);
    expect(document.querySelector("#activity-drawer")?.hasAttribute("hidden")).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npx vitest run src/renderer/novelai/ui-state.test.ts`

Expected: FAIL，提示无法找到 `./ui-state`。

- [ ] **Step 3: 实现最小状态控制器**

```ts
export type NovelAiPage = "create" | "library" | "settings";

export function showNovelAiPage(page: NovelAiPage, root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-nai-page]").forEach((panel) => {
    panel.toggleAttribute("hidden", panel.dataset.naiPage !== page);
  });
  root.querySelectorAll<HTMLElement>("[data-nai-route]").forEach((button) => {
    const active = button.dataset.naiRoute === page;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
}

export function setActivityDrawer(open: boolean, root: ParentNode = document): void {
  const toggle = root.querySelector<HTMLButtonElement>("#activity-toggle");
  const drawer = root.querySelector<HTMLElement>("#activity-drawer");
  if (!toggle || !drawer) return;
  toggle.setAttribute("aria-expanded", String(open));
  drawer.toggleAttribute("hidden", !open);
}

export function bindNovelAiUi(root: ParentNode = document): () => void {
  const cleanups: Array<() => void> = [];
  root.querySelectorAll<HTMLButtonElement>("[data-nai-route]").forEach((button) => {
    const click = () => showNovelAiPage(button.dataset.naiRoute as NovelAiPage, root);
    button.addEventListener("click", click);
    cleanups.push(() => button.removeEventListener("click", click));
  });
  root.querySelectorAll<HTMLButtonElement>("[data-return-to-create]").forEach((button) => {
    const click = () => showNovelAiPage("create", root);
    button.addEventListener("click", click);
    cleanups.push(() => button.removeEventListener("click", click));
  });
  const toggle = root.querySelector<HTMLButtonElement>("#activity-toggle");
  if (toggle) {
    const click = () => setActivityDrawer(toggle.getAttribute("aria-expanded") !== "true", root);
    toggle.addEventListener("click", click);
    cleanups.push(() => toggle.removeEventListener("click", click));
  }
  showNovelAiPage("create", root);
  setActivityDrawer(false, root);
  return () => cleanups.forEach((cleanup) => cleanup());
}
```

- [ ] **Step 4: 运行测试并确认通过**

Run: `npx vitest run src/renderer/novelai/ui-state.test.ts`

Expected: 1 file passed，3 tests passed。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/novelai/ui-state.ts src/renderer/novelai/ui-state.test.ts
git commit -m "feat(novelai): add beginner UI view state"
```

---

### Task 2: 新手主流程和独立页面结构

**Files:**
- Create: `src/renderer/novelai/layout.test.ts`
- Modify: `src/renderer/novelai/index.html`

**Interfaces:**
- Consumes: Task 1 的 `data-nai-*` 和抽屉接口。
- Produces: 保留现有全部 DOM `id`，新增 `#open-library`、`#open-settings`、`#download-result`。

- [ ] **Step 1: 写失败的页面结构契约测试**

```ts
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const html = fs.readFileSync(fileURLToPath(new URL("./index.html", import.meta.url)), "utf8");

describe("NovelAI beginner layout", () => {
  it("presents the three-step create flow", () => {
    expect(html).toContain('data-nai-page="create"');
    for (const label of ["1. 描述画面", "2. 选择角色与服装", "3. 开始绘制"]) expect(html).toContain(label);
    expect(html).toMatch(/id="natural-prompt"[\s\S]*id="prompt"/);
  });
  it("moves low-frequency tools to internal pages", () => {
    expect(html).toContain('id="open-library" data-nai-route="library"');
    expect(html).toContain('id="open-settings" data-nai-route="settings"');
    expect(html).toContain('data-nai-page="library" hidden');
    expect(html).toContain('data-nai-page="settings" hidden');
    expect(html).toContain("返回创作");
  });
  it("keeps advanced controls collapsed", () => {
    expect(html).toMatch(/<details class="advanced-settings">[\s\S]*?<summary>[\s\S]*高级设置/);
    expect(html).not.toMatch(/<details class="advanced-settings"[^>]* open/);
    for (const id of ["negative", "model", "width", "height", "steps", "scale", "sampler", "seed", "reference-mode", "variant-count"]) expect(html).toContain(`id="${id}"`);
  });
  it("provides the collapsed task drawer", () => {
    expect(html).toContain('id="activity-toggle"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('id="activity-drawer" hidden');
  });
  it("preserves critical integration ids", () => {
    for (const id of ["connection-badge", "generate", "status", "preview", "task-list", "history", "test", "save", "asset-library", "profile-character-select", "outfit-editor"]) expect(html).toContain(`id="${id}"`);
  });
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npx vitest run src/renderer/novelai/layout.test.ts`

Expected: FAIL，缺少 `data-nai-page="create"` 和新页面入口。

- [ ] **Step 3: 重组顶部和主创作区**

顶部加入以下入口，最小化和关闭按钮继续保留：

```html
<div class="titlebar__tools">
  <button id="open-library" type="button" data-nai-route="library">素材库</button>
  <button id="open-settings" type="button" data-nai-route="settings">设置</button>
  <span id="connection-badge" class="badge">未检测</span>
</div>
```

把现有生成表单移动到以下唯一结构中；不得复制任何既有 `id`。第一步卡片依次放入 `#natural-prompt`、`#translate-prompt`、`#prompt`；第二步卡片依次放入 `#drawing-character-select`、`#outfit-select-field`；高级设置依次放入当前从 `#negative` 到 `#variant-count` 的全部控件；操作卡片放入 `#generate` 和 `#status`：

```html
<section class="create-page" data-nai-page="create">
  <aside class="creation-panel" aria-label="绘图步骤">
    <section class="creation-step" data-create-step="prompt"></section>
    <section class="creation-step" data-create-step="character"></section>
    <details class="advanced-settings"><summary><span>高级设置</span><small>模型、尺寸、采样和参考图</small></summary><div class="advanced-settings__body"></div></details>
    <section class="creation-step creation-step--action" data-create-step="generate"></section>
  </aside>
  <section class="canvas-area"></section>
</section>
```

每个步骤容器内加入对应的 `step-number` 和 `h2` 标题；画布区按原顺序移动 `.canvas-toolbar`、`.prompt-inspector`、`#result-summary`、`#preview`。这是移动操作，不得通过 `innerHTML` 重建表单节点。

- [ ] **Step 4: 建立素材库、设置和任务抽屉**

把现有三个 `data-studio-panel="character"` 面板和一个 `data-studio-panel="reference"` 面板按原顺序移入 `.library-grid`；把 `data-studio-panel="connection"` 面板移入 `.settings-page__content`；把 `.task-panel` 和 `.history-panel` 移入 `#activity-drawer`。移除旧的 `data-studio-panel` 和 `data-studio-tab` 属性，其他 `id` 与表单内容不变。目标外壳为：

```html
<section class="utility-page" data-nai-page="library" hidden>
  <header class="utility-page__header"><button type="button" data-return-to-create>← 返回创作</button><div><h1>素材库</h1><p>管理角色、服装和参考素材</p></div></header>
  <div class="library-grid"></div>
</section>
<section class="utility-page" data-nai-page="settings" hidden>
  <header class="utility-page__header"><button type="button" data-return-to-create>← 返回创作</button><div><h1>设置</h1><p>配置 NovelAI API 连接</p></div></header>
  <div class="settings-page__content"></div>
</section>
<footer class="activity-shell">
  <button id="activity-toggle" type="button" aria-expanded="false" aria-controls="activity-drawer"><span id="activity-summary">暂无生成任务</span><span id="activity-chevron" aria-hidden="true">⌃</span></button>
  <section id="activity-drawer" hidden></section>
</footer>
```

- [ ] **Step 5: 验证并提交**

Run: `npx vitest run src/renderer/novelai/layout.test.ts`

Expected: 1 file passed，5 tests passed。

Run: `npm run build:renderer`

Expected: Vite build succeeds。

```bash
git add src/renderer/novelai/index.html src/renderer/novelai/layout.test.ts
git commit -m "feat(novelai): reorganize beginner creation flow"
```

---

### Task 3: 暖白画室主题和响应式专注画布

**Files:**
- Create: `src/renderer/novelai/style-contract.test.ts`
- Modify: `src/renderer/novelai/novelai.css`
- Modify: `src/renderer/novelai/wardrobe.css`

**Interfaces:**
- Consumes: Task 2 的 `.create-page`、`.creation-panel`、`.canvas-area`、`.utility-page`、`.activity-shell`、`.advanced-settings`。
- Produces: 暖白主题变量、桌面双栏、窄窗口单栏、可见焦点和状态色。

- [ ] **Step 1: 写失败的样式契约测试**

```ts
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = fs.readFileSync(fileURLToPath(new URL("./novelai.css", import.meta.url)), "utf8");
const wardrobe = fs.readFileSync(fileURLToPath(new URL("./wardrobe.css", import.meta.url)), "utf8");

describe("NovelAI warm studio styles", () => {
  it("defines the warm-white palette", () => {
    for (const token of ["--nai-canvas", "--nai-surface", "--nai-text", "--nai-muted", "--nai-accent", "--nai-danger"]) expect(css).toContain(token);
  });
  it("implements focus-canvas and activity layouts", () => {
    expect(css).toMatch(/\.create-page\s*\{[^}]*grid-template-columns/s);
    expect(css).toContain(".activity-shell");
    expect(css).toContain("#activity-drawer");
  });
  it("supports small windows and keyboard focus", () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*900px\)/);
    expect(css).toContain(":focus-visible");
  });
  it("removes old dark wardrobe colors", () => {
    expect(wardrobe).not.toContain("#100d20");
    expect(wardrobe).not.toContain("#171326");
  });
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npx vitest run src/renderer/novelai/style-contract.test.ts`

Expected: FAIL，缺少暖白主题变量。

- [ ] **Step 3: 建立暖白变量和主布局**

用下列根样式替换旧深色根样式，并让按钮、表单、卡片和状态全部引用这些变量：

```css
:root {
  font-family: "Microsoft YaHei UI", "Segoe UI", sans-serif;
  color: var(--nai-text);
  background: var(--nai-canvas);
  --nai-canvas: #f5f0e8;
  --nai-surface: #fffdf9;
  --nai-surface-soft: #fbf6ee;
  --nai-text: #3f372f;
  --nai-muted: #8c7e72;
  --nai-line: #e8ded1;
  --nai-accent: #df855e;
  --nai-accent-strong: #c96c46;
  --nai-success: #56866a;
  --nai-danger: #b65454;
  --nai-shadow: 0 16px 40px rgba(88, 67, 48, 0.10);
}
* { box-sizing: border-box; }
body { margin: 0; overflow: hidden; background: var(--nai-canvas); }
.studio { min-height: 100vh; display: grid; grid-template-rows: 72px minmax(0, 1fr) auto; }
.create-page { min-height: 0; display: grid; grid-template-columns: minmax(320px, 390px) minmax(0, 1fr); gap: 20px; padding: 20px; }
.creation-panel, .canvas-area, .utility-page { background: var(--nai-surface); border: 1px solid var(--nai-line); border-radius: 18px; box-shadow: var(--nai-shadow); }
.creation-panel { overflow: auto; padding: 20px; }
.canvas-area { min-width: 0; overflow: auto; padding: 22px; }
button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 3px solid rgba(223, 133, 94, .32); outline-offset: 2px; }
```

主按钮使用 `--nai-accent`，普通按钮和输入使用 `--nai-surface-soft`、`--nai-line`、`--nai-text`，错误和成功分别使用 `--nai-danger`、`--nai-success`。删除两份 CSS 中旧的紫黑背景、粉紫渐变和白色输入文字硬编码。

- [ ] **Step 4: 添加独立页面、抽屉和响应式样式**

```css
.utility-page { min-height: 0; margin: 20px; padding: 24px; overflow: auto; }
.utility-page[hidden], [data-nai-page][hidden], #activity-drawer[hidden] { display: none !important; }
.activity-shell { position: relative; z-index: 5; border-top: 1px solid var(--nai-line); background: var(--nai-surface); }
#activity-toggle { width: 100%; min-height: 44px; display: flex; align-items: center; justify-content: space-between; padding: 0 22px; border: 0; background: transparent; color: var(--nai-text); }
#activity-drawer { max-height: min(48vh, 520px); display: grid; grid-template-columns: minmax(260px, .7fr) minmax(0, 1.3fr); gap: 18px; padding: 18px 22px 22px; overflow: auto; border-top: 1px solid var(--nai-line); }
#activity-toggle[aria-expanded="true"] #activity-chevron { transform: rotate(180deg); }
@media (max-width: 900px) {
  body { overflow: auto; }
  .studio { min-height: 100vh; height: auto; }
  .create-page { grid-template-columns: 1fr; }
  .creation-panel, .canvas-area { overflow: visible; }
  #activity-drawer { grid-template-columns: 1fr; max-height: none; }
}
```

- [ ] **Step 5: 验证并提交**

Run: `npx vitest run src/renderer/novelai/style-contract.test.ts src/renderer/novelai/layout.test.ts`

Expected: 2 files passed，9 tests passed。

Run: `npm run build:renderer`

Expected: Vite build succeeds。

```bash
git add src/renderer/novelai/novelai.css src/renderer/novelai/wardrobe.css src/renderer/novelai/style-contract.test.ts
git commit -m "style(novelai): add warm focus-canvas studio"
```

---

### Task 4: 导航、任务摘要和结果操作接线

**Files:**
- Modify: `src/renderer/novelai/main.ts`
- Modify: `src/renderer/novelai/index.html`
- Modify: `src/renderer/novelai/ui-state.test.ts`
- Modify: `src/renderer/novelai/layout.test.ts`

**Interfaces:**
- Consumes: `bindNovelAiUi()`、`showNovelAiPage()`、`setActivityDrawer()`；现有 `NovelAiResult` 和 `ImageTask`。
- Produces: 初始创作页、实时 `#activity-summary`、`#download-result` 和失败详情入口。

- [ ] **Step 1: 扩充失败测试**

在 `layout.test.ts` 增加：

```ts
it("offers result actions and an accessible status region", () => {
  expect(html).toContain('id="download-result"');
  expect(html).toContain('id="open-output"');
  expect(html).toContain('id="status" class="status" role="status" aria-live="polite"');
  expect(html).toContain('id="status-details" hidden');
  expect(html).toContain('id="status-technical"');
});
```

在 `ui-state.test.ts` 增加：

```ts
it("toggles the drawer through its bound button", () => {
  bindNovelAiUi();
  (document.querySelector("#activity-toggle") as HTMLButtonElement).click();
  expect(document.querySelector("#activity-drawer")?.hasAttribute("hidden")).toBe(false);
  expect(document.querySelector("#activity-toggle")?.getAttribute("aria-expanded")).toBe("true");
});
```

- [ ] **Step 2: 运行测试并确认新增断言失败**

Run: `npx vitest run src/renderer/novelai/layout.test.ts src/renderer/novelai/ui-state.test.ts`

Expected: layout test FAIL，提示缺少 `download-result`。

- [ ] **Step 3: 接入状态控制器**

在 `main.ts` 顶部加入：

```ts
import { bindNovelAiUi, setActivityDrawer, showNovelAiPage } from "./ui-state";
```

删除旧的 `[data-studio-tab]` 点击绑定和文件末尾模拟点击，改为：

```ts
bindNovelAiUi();
showNovelAiPage("create");
renderInspector();
```

保留 `[data-prompt-tab]` 的提示词检查标签逻辑。

- [ ] **Step 4: 在 `renderTasks` 同步简明摘要**

```ts
const activitySummary = $<HTMLElement>("activity-summary");
const activeTask = tasks.find((task) => task.status === "running" || task.status === "queued");
const failedTask = tasks.find((task) => task.status === "failed");
activitySummary.textContent = activeTask
  ? `${activeTask.status === "running" ? "正在生成" : "等待生成"} · ${activeTask.prompt}`
  : failedTask
    ? `生成失败 · ${failedTask.error || "点击查看详情"}`
    : tasks.length
      ? `最近共有 ${tasks.length} 项任务`
      : "暂无生成任务";
activitySummary.classList.toggle("is-error", Boolean(failedTask && !activeTask));
```

只在生成提交或任务重试失败的 `catch` 中调用 `setActivityDrawer(true)`；普通空表单提示不得自动展开抽屉。

- [ ] **Step 5: 添加下载、打开目录和再次绘制**

结果操作区使用：

```html
<a id="download-result" class="result-action" hidden>下载图片</a>
<button id="open-output" type="button">打开保存目录</button>
<button id="load-result-params" type="button">使用当前设置再次绘制</button>
```

在 `showResult(item)` 中加入：

```ts
const download = $<HTMLAnchorElement>("download-result");
download.href = item.dataUrl;
download.download = `novelai-${item.id}.png`;
download.hidden = false;
```

在 `#status` 后加入默认隐藏的技术详情：

```html
<details id="status-details" hidden><summary>查看技术详情</summary><pre id="status-technical"></pre></details>
```

把 `setStatus` 扩展为可选详情参数，现有两参数调用保持兼容：

```ts
function setStatus(text: string, error = false, detail?: unknown): void {
  status.textContent = text;
  status.classList.toggle("error", error);
  const details = $<HTMLDetailsElement>("status-details");
  const technical = $<HTMLPreElement>("status-technical");
  technical.textContent = detail instanceof Error ? detail.stack || detail.message : detail ? String(detail) : "";
  details.hidden = !technical.textContent;
  if (details.hidden) details.open = false;
}
```

生成、任务重试和连接测试的 `catch` 使用 `setStatus(易懂摘要, true, error)`。`refreshAssets()` 的异常摘要固定为“参考素材加载失败，仍可继续使用文字绘图。”，并把原错误作为第三参数；不得让素材失败中断生成表单初始化。

- [ ] **Step 6: 验证并提交**

Run: `npx vitest run src/renderer/novelai/ui-state.test.ts src/renderer/novelai/layout.test.ts src/renderer/novelai/style-contract.test.ts`

Expected: 3 files passed，所有断言通过。

Run: `npm run build:renderer`

Expected: Vite build succeeds without TypeScript or Rollup errors。

```bash
git add src/renderer/novelai/main.ts src/renderer/novelai/index.html src/renderer/novelai/ui-state.test.ts src/renderer/novelai/layout.test.ts
git commit -m "feat(novelai): wire beginner studio interactions"
```

---

### Task 5: 回归验证、人工走查和施工记录

**Files:**
- Create: `docs/superpowers/plans/2026-08-09-novelai-beginner-ui-construction-log.md`
- Modify only if a defect is found: `src/renderer/novelai/index.html`
- Modify only if a defect is found: `src/renderer/novelai/main.ts`
- Modify only if a defect is found: `src/renderer/novelai/novelai.css`
- Modify only if a defect is found: `src/renderer/novelai/wardrobe.css`
- Modify only if a defect is found: matching `src/renderer/novelai/*.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4 的完整界面。
- Produces: 自动测试证据、人工检查结果和施工记录。

- [ ] **Step 1: 运行聚焦测试**

Run: `npx vitest run src/renderer/novelai/ui-state.test.ts src/renderer/novelai/layout.test.ts src/renderer/novelai/style-contract.test.ts`

Expected: 3 files passed，所有测试通过。

- [ ] **Step 2: 运行完整测试和构建**

Run: `npm test`

Expected: exit code 0；记录实际通过与跳过数量。若出现既有失败，保存错误文本并先确认基线。

Run: `npm run build`

Expected: skills、main、preload、CLI 和 renderer 全部成功，exit code 0。

- [ ] **Step 3: 启动并人工走查**

Run: `npm start`

检查以下十项：

1. 初始只显示创作页和三个步骤，底部抽屉收起。
2. 中文描述和英文 Prompt 同时可见并可编辑。
3. 高级设置默认折叠，展开后全部原参数存在。
4. 角色和服装选择后，提示词检查照常更新。
5. 素材库、设置与创作页切换后，输入不丢失。
6. 生成时按钮等待，底部摘要显示进度。
7. 完成后图片、下载、打开目录、再次绘制可用。
8. 任务重试、历史筛选、收藏和删除仍可用。
9. 窗口缩小到约 900px 宽时变为单栏且无遮挡。
10. Tab 键焦点清晰，状态文字易懂。

- [ ] **Step 4: 写真实施工记录**

施工记录必须填写实际结果，不预填测试结论。结构固定为：完成内容、自动验证、人工走查、保留事项。自动验证逐项写明命令、退出码和通过数量；没有保留问题时明确写“无”。

- [ ] **Step 5: 检查范围并提交**

Run: `git status --short`

Expected: 只出现计划涉及的源文件、测试、施工记录，以及用户原有的两个 `dist` 工作区项目。

Run: `git diff --check`

Expected: no output。

Run: `git diff --cached --name-only`

Expected: no `dist/` path。

提交命令：

```bash
git add docs/superpowers/plans/2026-08-09-novelai-beginner-ui-construction-log.md src/renderer/novelai
git commit -m "docs(novelai): record beginner UI verification"
```

---

## Final Verification Gate

执行者必须依次运行并报告实际输出摘要：

1. `npx vitest run src/renderer/novelai/ui-state.test.ts src/renderer/novelai/layout.test.ts src/renderer/novelai/style-contract.test.ts`
2. `npm test`
3. `npm run build`
4. `git diff --check`
5. `git status --short`
6. `git log --oneline -6`

允许工作区继续保留用户已有的 `dist/renderer/react/index.html` 和 `dist/renderer/novelai/`，但这些路径不得进入任何提交或推送范围。
