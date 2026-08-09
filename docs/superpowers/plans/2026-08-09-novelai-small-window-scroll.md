# NovelAI Small-Window Scrolling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the NovelAI desktop two-column workspace keep its header fixed while the left creation panel and right canvas scroll independently in short windows.

**Architecture:** Constrain the desktop `.studio` grid to the viewport so its `minmax(0, 1fr)` work row has a real height, then make the two work panels explicit vertical scroll containers. At the existing 900px single-column breakpoint, release the viewport constraint and restore natural page scrolling to avoid nested scrollbars.

**Tech Stack:** CSS Grid, Chromium/Electron scrolling, Vitest CSS contract tests, Vite, Playwright browser smoke checks.

## Global Constraints

- Preserve the existing warm-white visual style and all NovelAI generation behavior.
- Desktop widths above 900px use two independent panel scroll containers.
- Widths at or below 900px use one natural page scroll container.
- Generated images keep their existing aspect-ratio-preserving `object-fit: contain` behavior.
- Do not commit `dist/` or `.superpowers/sdd/` artifacts.

## File Map

- `src/renderer/novelai/novelai.css`: Owns viewport sizing, the two-column work grid, panel scrolling, and the 900px single-column reset.
- `src/renderer/novelai/style-contract.test.ts`: Prevents future CSS changes from removing the desktop height constraint or either scroll-mode rule.
- `docs/superpowers/plans/2026-08-09-novelai-beginner-ui-construction-log.md`: Records the regression, RED/GREEN evidence, browser smoke result, and final verification.

---

### Task 1: Restore independent desktop panel scrolling

**Files:**
- Modify: `src/renderer/novelai/style-contract.test.ts`
- Modify: `src/renderer/novelai/novelai.css`

**Interfaces:**
- Consumes: Existing `.studio`, `.create-page`, `.creation-panel`, `.canvas-area`, and `@media (max-width: 900px)` selectors.
- Produces: A viewport-constrained desktop grid and two independent vertical scroll containers, with a single-column reset below 900px.

- [ ] **Step 1: Write the failing CSS contract test**

Append this test inside the existing `describe("NovelAI warm studio styles", ...)` block:

```ts
it("keeps desktop work panels independently scrollable in short windows", () => {
  expect(css).toMatch(/\.studio\s*\{[^}]*height:\s*100vh/s);
  expect(css).toMatch(
    /\.creation-panel,\s*\.canvas-area\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto[^}]*overscroll-behavior:\s*contain/s,
  );
  expect(css).toMatch(
    /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\.studio\s*\{[^}]*height:\s*auto/s,
  );
  expect(css).toMatch(
    /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\.creation-panel,\s*\.canvas-area\s*\{[^}]*min-height:\s*auto[^}]*overflow:\s*visible[^}]*overscroll-behavior:\s*auto/s,
  );
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm.cmd test -- src/renderer/novelai/style-contract.test.ts
```

Expected: FAIL because the desktop `.studio` block has no `height: 100vh`, and the paired panel block has no explicit `min-height`, `overflow-y`, or overscroll contract.

- [ ] **Step 3: Implement the minimal desktop and narrow-window CSS rules**

Change the desktop layout rules to:

```css
.studio { min-height: 0; height: 100vh; display: grid; grid-template-rows: 72px minmax(0, 1fr) auto; background: var(--nai-canvas); }

.creation-panel, .canvas-area { min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.creation-panel { min-width: 0; padding: 20px; scrollbar-color: var(--nai-muted) transparent; }
.canvas-area { min-width: 0; padding: 22px; }
```

Change the existing 900px reset to:

```css
@media (max-width: 900px) {
  body { overflow: auto; }
  .studio { min-height: 100vh; height: auto; grid-template-rows: auto minmax(0, 1fr) auto; }
  .titlebar { flex-wrap: wrap; height: auto; min-height: 72px; padding: 12px 16px; }
  .titlebar__tools { flex-wrap: wrap; }
  .create-page { grid-template-columns: 1fr; overflow: visible; padding: 14px; }
  .creation-panel, .canvas-area { min-height: auto; overflow: visible; overscroll-behavior: auto; }
  .utility-page { margin: 14px; padding: 18px; }
  #activity-drawer { grid-template-columns: 1fr; max-height: none; }
}
```

- [ ] **Step 4: Run the focused NovelAI tests and verify GREEN**

Run:

```powershell
npm.cmd test -- src/renderer/novelai/style-contract.test.ts src/renderer/novelai/layout.test.ts
```

Expected: 2 test files pass with no failed assertions.

- [ ] **Step 5: Commit the regression test and fix**

```powershell
git add src/renderer/novelai/style-contract.test.ts src/renderer/novelai/novelai.css
git commit -m "fix(novelai): restore short-window panel scrolling"
```

---

### Task 2: Verify real layout behavior and record evidence

**Files:**
- Modify: `docs/superpowers/plans/2026-08-09-novelai-beginner-ui-construction-log.md`

**Interfaces:**
- Consumes: The desktop and narrow-window scroll rules from Task 1.
- Produces: Repeatable verification evidence and an updated construction record; no runtime API changes.

- [ ] **Step 1: Build the renderer**

Run:

```powershell
npm.cmd run build:renderer
```

Expected: Vite exits 0 and emits `dist/renderer/novelai/index.html`; the existing large-chunk warning is allowed.

- [ ] **Step 2: Run a wide, short browser smoke check**

Serve the renderer with Vite on a free localhost port, open `/src/renderer/novelai/` in Playwright using a 1200 x 620 viewport, and inspect `.creation-panel` and `.canvas-area`.

Required assertions:

```ts
const before = await page.evaluate(() => ({
  left: document.querySelector<HTMLElement>(".creation-panel")!.scrollTop,
  right: document.querySelector<HTMLElement>(".canvas-area")!.scrollTop,
  leftScrollable: document.querySelector<HTMLElement>(".creation-panel")!.scrollHeight
    > document.querySelector<HTMLElement>(".creation-panel")!.clientHeight,
  rightScrollable: document.querySelector<HTMLElement>(".canvas-area")!.scrollHeight
    > document.querySelector<HTMLElement>(".canvas-area")!.clientHeight,
}));
expect(before.leftScrollable).toBe(true);
expect(before.rightScrollable).toBe(true);

await page.locator(".creation-panel").evaluate((node) => { node.scrollTop = 240; });
expect(await page.locator(".canvas-area").evaluate((node) => node.scrollTop)).toBe(before.right);

await page.locator(".canvas-area").evaluate((node) => { node.scrollTop = 240; });
expect(await page.locator(".creation-panel").evaluate((node) => node.scrollTop)).toBe(240);
```

Expected: Both panels have positive scroll ranges, and scrolling either panel leaves the other panel unchanged.

- [ ] **Step 3: Run a narrow-window browser smoke check**

Resize the same page to 820 x 620 and assert:

```ts
const narrow = await page.evaluate(() => ({
  bodyOverflow: getComputedStyle(document.body).overflow,
  leftOverflow: getComputedStyle(document.querySelector<HTMLElement>(".creation-panel")!).overflow,
  rightOverflow: getComputedStyle(document.querySelector<HTMLElement>(".canvas-area")!).overflow,
}));
expect(narrow.bodyOverflow).toBe("auto");
expect(narrow.leftOverflow).toBe("visible");
expect(narrow.rightOverflow).toBe("visible");
```

Expected: The page uses natural document scrolling and neither panel creates a nested scrollbar.

- [ ] **Step 4: Run the NovelAI suite and full test/build gates**

Run:

```powershell
npm.cmd test -- src/plugins/novelai src/renderer/novelai
New-Item -ItemType Directory -Force "$PWD\.superpowers\sdd\test-profile-scroll-fix" | Out-Null
$env:USERPROFILE = "$PWD\.superpowers\sdd\test-profile-scroll-fix"
npm.cmd test
npm.cmd run build
git diff --check HEAD~1..HEAD
```

Expected: Focused and full tests exit 0; the full build exits 0; diff check emits no errors. The isolated `USERPROFILE` prevents Cline's integration tests from attempting to write a SQLite database in the real Windows profile.

- [ ] **Step 5: Update the construction log**

Append a “小窗口独立滚动修复” section containing:

```markdown
## 小窗口独立滚动修复

- 根因：桌面工作室只有 `min-height`，外层又隐藏溢出，主网格没有形成受视口约束的中间行，左右面板的滚动容器无法可靠生效。
- 修复：桌面双栏固定为一个视口高，左右面板独立纵向滚动；900px 以下解除固定高度并恢复整页滚动。
- RED：记录聚焦样式测试的失败断言。
- GREEN：记录聚焦测试、浏览器宽矮/窄窗冒烟、完整测试和完整构建的实际结果。
- 构建生成的 `dist/` 仅保留在本地，不纳入提交。
```

- [ ] **Step 6: Commit the construction record**

```powershell
git add docs/superpowers/plans/2026-08-09-novelai-beginner-ui-construction-log.md
git commit -m "docs(novelai): record short-window scroll verification"
```
