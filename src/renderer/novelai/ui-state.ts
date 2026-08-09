export type NovelAiPage = "create" | "library" | "settings";
type UtilityPage = Exclude<NovelAiPage, "create">;

export function showNovelAiPage(page: NovelAiPage, root: ParentNode = document, moveFocus = true): void {
  root.querySelectorAll<HTMLElement>("[data-nai-page]").forEach((panel) => {
    panel.toggleAttribute("hidden", panel.dataset.naiPage !== page);
  });
  root.querySelectorAll<HTMLElement>("[data-nai-route]").forEach((button) => {
    const active = button.dataset.naiRoute === page;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  if (moveFocus) {
    root.querySelector<HTMLElement>(`[data-nai-page="${page}"] [data-nai-page-title]`)?.focus({ preventScroll: true });
  }
}

export function setActivityDrawer(open: boolean, root: ParentNode = document): void {
  const toggle = root.querySelector<HTMLButtonElement>("#activity-toggle");
  const drawer = root.querySelector<HTMLElement>("#activity-drawer");
  if (!toggle || !drawer) return;
  toggle.setAttribute("aria-expanded", String(open));
  drawer.toggleAttribute("hidden", !open);
}

export function setCreateConnectionWarning(connected: boolean, root: ParentNode = document): void {
  const warning = root.querySelector<HTMLElement>("#create-connection-warning");
  if (!warning) return;
  const message = warning.querySelector<HTMLElement>("#create-connection-message");
  if (message) message.textContent = "API 尚未连接";
  warning.toggleAttribute("hidden", connected);
}

function reportStatusRegion(prefix: string, text: string, error: boolean, detail: unknown, root: ParentNode): void {
  const status = root.querySelector<HTMLElement>(`#${prefix}`);
  const details = root.querySelector<HTMLDetailsElement>(`#${prefix}-details`);
  const technical = root.querySelector<HTMLPreElement>(`#${prefix}-technical`);
  if (!status || !details || !technical) return;
  status.textContent = text;
  status.classList.toggle("is-error", error);
  status.classList.toggle("is-success", Boolean(text) && !error);
  technical.textContent = detail instanceof Error ? detail.stack || detail.message : detail ? String(detail) : "";
  details.hidden = !technical.textContent;
  if (details.hidden) details.open = false;
}

export function reportCreateStatus(text: string, error = false, detail?: unknown, root: ParentNode = document): void {
  reportStatusRegion("status", text, error, detail, root);
  root.querySelector<HTMLElement>("#status")?.classList.toggle("error", error);
}

export function reportAssetStatus(text: string, error = false, detail?: unknown, root: ParentNode = document): void {
  reportStatusRegion("asset-status", text, error, detail, root);
}

export function reportAssetSelection(count: number, root: ParentNode = document): void {
  reportAssetStatus(count > 0 ? `已选择 ${count} 张参考素材。再次点击可取消选择。` : "已清空参考素材。", false, undefined, root);
}

export function syncAssetSelectionState(item: HTMLElement, selected: boolean): void {
  item.classList.toggle("is-selected", selected);
  item.setAttribute("aria-selected", String(selected));
}

export function reportUtilityStatus(page: UtilityPage, text: string, error = false, detail?: unknown, root: ParentNode = document): void {
  reportStatusRegion(`${page}-status`, text, error, detail, root);
  if (page === "settings" && error) {
    const badge = root.querySelector<HTMLElement>("#connection-badge");
    if (badge) {
      badge.textContent = "设置失败";
      badge.classList.remove("ok");
      badge.classList.add("error");
    }
  }
}

interface AssetActionOptions<T> {
  errorMessage: string;
  clearOnSuccess?: boolean;
  isFailure?: (result: T) => boolean;
  failureDetail?: string;
  root?: ParentNode;
}

export async function runAssetAction<T>(action: () => Promise<T>, options: AssetActionOptions<T>): Promise<T | undefined> {
  const root = options.root || document;
  try {
    const result = await action();
    if (options.isFailure?.(result)) throw new Error(options.failureDetail || options.errorMessage);
    if (options.clearOnSuccess) reportAssetStatus("", false, undefined, root);
    return result;
  } catch (error) {
    reportAssetStatus(options.errorMessage, true, error, root);
    return undefined;
  }
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
  showNovelAiPage("create", root, false);
  setActivityDrawer(false, root);
  return () => cleanups.forEach((cleanup) => cleanup());
}
