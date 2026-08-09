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
