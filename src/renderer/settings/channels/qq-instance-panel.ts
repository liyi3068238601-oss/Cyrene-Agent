import type { QqBackend, QqInstanceRequest, QqInstanceStatus } from "../../../shared/qq-instance";

interface QqPublicConfig { qq?: { enabled?: boolean; blockedUserIds?: string[]; blockedGroupIds?: string[] } }

export function bindQqInstancePanel(onChanged: () => Promise<void>): void {
  const panels = [
    { prefix: "qq-instance", backend: "snowluma" as QqBackend, element: document.getElementById("qq-instance-panel") },
    { prefix: "qq-napcat-instance", backend: "napcat" as QqBackend, element: document.getElementById("qq-napcat-instance-panel") },
  ].filter(item => item.element);
  if (!panels.length) return;
  const privateList = document.getElementById("qq-instance-user-blocklist") as HTMLTextAreaElement;
  const groupList = document.getElementById("qq-instance-group-blocklist") as HTMLTextAreaElement;
  const save = document.getElementById("qq-instance-save-blocklists") as HTMLButtonElement;
  const saveFeedback = document.getElementById("qq-instance-save-feedback")!;
  let busy = false;
  let current: QqInstanceStatus | undefined;
  let dirty = false;
  let draftAccount: string | undefined;
  let lastError = "";
  const field = <T extends HTMLElement>(prefix: string, suffix: string) => document.getElementById(prefix + "-" + suffix) as T;
  const render = (state: QqInstanceStatus) => {
    current = state;
    const phases = { absent: "未创建", installing: "安装中", stopped: "已停止", starting: "启动中", running: "运行中", error: "异常" };
    const locked = busy || state.phase === "installing";
    for (const { prefix, backend, element } of panels) {
      const owned = state.instance?.backend === backend;
      const occupied = Boolean(state.instance && !owned);
      const account = field<HTMLInputElement>(prefix, "account");
      const auto = field<HTMLInputElement>(prefix, "auto");
      const feedback = field<HTMLElement>(prefix, "feedback");
      feedback.textContent = occupied ? "另一 QQ 后端已占用唯一实例；请先在对应卡片停止并删除实例。" :
        lastError || `${phases[state.phase]} · ${state.message}\n数据目录：${state.root}`;
      account.disabled = locked || Boolean(state.instance);
      auto.disabled = locked || !owned;
      if (owned) { account.value = state.instance!.accountId; auto.checked = state.instance!.autoStart; }
      for (const button of element!.querySelectorAll<HTMLButtonElement>("button[data-action]")) {
        const action = button.dataset.action;
        button.disabled = locked || occupied || (action === "create" ? Boolean(state.instance) :
          action === "open" ? !owned || !state.webuiUrl : action === "delete" ? backend === "napcat" && !owned : !owned);
      }
    }
    field<HTMLInputElement>("qq-instance", "url").value = state.instance?.backend === "snowluma" ? state.webuiUrl ?? "" : "";
    field<HTMLInputElement>("qq-instance", "onebot-url").value = state.onebotUrl ?? "";
    const slOwned = state.instance?.backend === "snowluma";
    privateList.disabled = groupList.disabled = save.disabled = locked || !slOwned;
    // Keep legacy DOM references for existing autosave, but prevent NapCat controls
    // from editing/restarting the SL-owned channel.
    const napcatCard = document.getElementById("qq-napcat-card");
    for (const control of napcatCard?.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>('[id^="channels-qq-"]') ?? []) {
      control.disabled = slOwned || locked;
    }
    const switchElement = document.getElementById("channels-qq-enabled")?.parentElement;
    if (switchElement) switchElement.hidden = slOwned;
    const legacyStatus = document.getElementById("channels-qq-status");
    if (legacyStatus) legacyStatus.hidden = slOwned;
    const legacyControls = document.getElementById("qq-napcat-legacy-controls");
    if (legacyControls) legacyControls.hidden = slOwned;
  };
  const refresh = async () => {
    try {
      const state = await window.settings.channelsQqInstance({ action: "status" });
      render(state);
      const config = await window.settings.channelsGetConfig() as QqPublicConfig;
      if (!dirty || draftAccount !== state.instance?.accountId) {
        privateList.value = (config.qq?.blockedUserIds ?? []).join("\n");
        groupList.value = (config.qq?.blockedGroupIds ?? []).join("\n");
        draftAccount = state.instance?.accountId;
        dirty = false;
      }
    } catch (error) {
      field<HTMLElement>("qq-instance", "feedback").textContent = error instanceof Error ? error.message : String(error);
    }
  };
  const execute = async (request: QqInstanceRequest) => {
    busy = true; lastError = "";
    if (current) render(current);
    try {
      render(await window.settings.channelsQqInstance(request));
      await onChanged();
      const config = await window.settings.channelsGetConfig() as QqPublicConfig;
      const enabled = document.getElementById("channels-qq-enabled") as HTMLInputElement | null;
      if (enabled) enabled.checked = config.qq?.enabled === true;
    } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
    finally { busy = false; if (current) render(current); }
  };
  for (const { prefix, backend, element } of panels) {
    element!.addEventListener("click", event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-action]");
      if (!button || button.disabled || busy) return;
      const action = button.dataset.action as QqInstanceRequest["action"];
      const removeData = backend === "snowluma" && field<HTMLInputElement>(prefix, "remove-data").checked;
      if (action === "delete" && !window.confirm(removeData ?
        "删除实例及 SL 安装、登录、日志？保留 Cyrene 对话和记忆。请先在 WebUI 卸载 Hook。" :
        "删除 QQ 账号绑定？运行数据会保留，SL 重建前需勾选清理数据再删除。")) return;
      void execute({ action, accountId: field<HTMLInputElement>(prefix, "account").value.trim(), backend, removeData });
    });
    field<HTMLInputElement>(prefix, "auto").addEventListener("change", () => void execute({
      action: "configure", autoStart: field<HTMLInputElement>(prefix, "auto").checked,
    }));
  }
  privateList.addEventListener("input", () => { dirty = true; });
  groupList.addEventListener("input", () => { dirty = true; });
  save.addEventListener("click", async () => {
    if (busy || current?.instance?.backend !== "snowluma") return;
    const parse = (value: string) => [...new Set(value.split(/[\s,，;；]+/).filter(Boolean))];
    const users = parse(privateList.value), groups = parse(groupList.value);
    if ([...users, ...groups].some(id => !/^[1-9]\d{4,11}$/.test(id))) {
      saveFeedback.textContent = "请输入有效 QQ 号或群号，用换行或逗号分隔。"; return;
    }
    busy = true; if (current) render(current);
    try {
      await window.settings.channelsSaveConfig({ qq: { blockedUserIds: users, blockedGroupIds: groups } });
      dirty = false;
      saveFeedback.textContent = users.length || groups.length ? "黑名单已保存并即时生效，未重启 SL。" : "已清空黑名单：未被拉黑的消息默认放行，群聊仍需 @。";
      await onChanged();
    } catch (error) { saveFeedback.textContent = error instanceof Error ? error.message : String(error); }
    finally { busy = false; if (current) render(current); }
  });
  void refresh();
  const timer = window.setInterval(() => void refresh(), 2000);
  window.addEventListener("beforeunload", () => window.clearInterval(timer), { once: true });
}
