// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { bindNovelAiUi, setCreateConnectionWarning } from "./ui-state";

const html = fs.readFileSync(path.resolve(process.cwd(), "src/renderer/novelai/index.html"), "utf8");

function nextTabStop(document: Document, current: Element): HTMLElement | undefined {
  const elements = Array.from(document.querySelectorAll<HTMLElement>("*"));
  const start = elements.indexOf(current as HTMLElement);
  return elements.slice(start + 1).find((element) => {
    if (element.closest("[hidden]") || element.matches(":disabled")) return false;
    return element.tabIndex >= 0 && element.matches("button, input, select, textarea, a[href], [tabindex]");
  });
}

describe("NovelAI real DOM navigation", () => {
  it("returns focus to the start of creation so the next Tab reaches the natural prompt", () => {
    const document = new JSDOM(html).window.document;
    bindNovelAiUi(document);
    (document.querySelector('[data-nai-route="library"]') as HTMLButtonElement).click();
    (document.querySelector('[data-nai-page="library"] [data-return-to-create]') as HTMLButtonElement).click();

    const createTitle = document.querySelector('[data-nai-page="create"] [data-nai-page-title]') as HTMLElement;
    expect(document.activeElement).toBe(createTitle);
    expect(nextTabStop(document, createTitle)?.id).toBe("natural-prompt");
  });

  it("shows a nearby API warning, clears it on success, and routes its action to settings", () => {
    const document = new JSDOM(html).window.document;
    bindNovelAiUi(document);

    setCreateConnectionWarning(false, document);
    const warning = document.querySelector("#create-connection-warning") as HTMLElement;
    expect(warning.hasAttribute("hidden")).toBe(false);
    expect(warning.textContent).toContain("API 尚未连接");

    setCreateConnectionWarning(true, document);
    expect(warning.hasAttribute("hidden")).toBe(true);

    setCreateConnectionWarning(false, document);
    (document.querySelector("#create-connection-settings") as HTMLButtonElement).click();
    expect(document.querySelector('[data-nai-page="settings"]')?.hasAttribute("hidden")).toBe(false);
    expect(document.activeElement).toBe(document.querySelector('[data-nai-page="settings"] [data-nai-page-title]'));
  });
});
