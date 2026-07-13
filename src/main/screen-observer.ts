import type { VisionConfig, VisionImage } from "./orchestrator/vision-captioner";
import type { ScreenCapture } from "./orchestrator/screen-observation-tool";

export interface ScreenObserverConfig {
  enabled: boolean;
  intervalMinutes: number;
}

export interface ScreenObserverDeps {
  captureScreen: () => Promise<ScreenCapture | null>;
  getVisionConfig: () => VisionConfig | null;
  analyzeImage: (image: VisionImage, question: string, config: VisionConfig) => Promise<string>;
  createFingerprint: (capture: ScreenCapture) => Uint8Array;
  now?: () => number;
}

export interface ScreenObservation {
  text: string;
  observedAt: number;
}

export type ScreenObserverPhase = "disabled" | "waiting" | "observing" | "paused" | "unconfigured" | "error";

export interface ScreenObserverStatus {
  phase: ScreenObserverPhase;
  enabled: boolean;
  pauseUntil: number | null;
  pausedUntilRestart: boolean;
  lastCheckAt: number | null;
  lastObservationAt: number | null;
  summary: string;
  unchangedSkips: number;
  visionCalls: number;
  lastOutcome: string;
}

const CHECK_INTERVAL_MS = 30_000;
const CONTEXT_MAX_AGE_MS = 30 * 60_000;
const CHANGE_RATIO = 0.14;
const OBSERVATION_PROMPT = [
  "请概括当前屏幕正在进行的主要活动，供桌面陪伴 Agent 了解用户此刻的状态。",
  "只描述应用类型、任务阶段、明显的成功或错误状态，不要逐字抄录聊天、邮件、账号、验证码、密钥、支付或其他隐私内容。",
  "如果画面包含登录、支付、密码、私聊等敏感内容，只回答‘屏幕包含敏感内容，细节已省略’，可以补充非敏感的应用类型。",
  "控制在 120 字以内，不要推测看不清的内容。",
].join("\n");

let timer: ReturnType<typeof setInterval> | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let lastCheckedAt = 0;
let lastFingerprint: Uint8Array | null = null;
let latestObservation: ScreenObservation | null = null;
let pauseUntil = 0;
let runtimeStatus: ScreenObserverStatus = {
  phase: "disabled",
  enabled: false,
  pauseUntil: null,
  pausedUntilRestart: false,
  lastCheckAt: null,
  lastObservationAt: null,
  summary: "",
  unchangedSkips: 0,
  visionCalls: 0,
  lastOutcome: "尚未开始观察",
};

export function fingerprintChangeRatio(previous: Uint8Array, next: Uint8Array): number {
  if (previous.length !== next.length || previous.length === 0) return 1;
  let changed = 0;
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[index]) changed += 1;
  }
  return changed / previous.length;
}

export function recordScreenObservation(text: string, observedAt = Date.now()): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  latestObservation = { text: trimmed, observedAt };
  runtimeStatus.summary = trimmed;
  runtimeStatus.lastObservationAt = observedAt;
}

export function clearScreenObservation(): void {
  latestObservation = null;
  runtimeStatus.summary = "";
  runtimeStatus.lastObservationAt = null;
}

export function getLatestScreenObservation(): ScreenObservation | null {
  return latestObservation ? { ...latestObservation } : null;
}

export function pauseScreenObservation(durationMs: number | null, now = Date.now()): ScreenObserverStatus {
  pauseUntil = durationMs === null ? Number.POSITIVE_INFINITY : now + Math.max(1_000, durationMs);
  runtimeStatus.phase = "paused";
  runtimeStatus.pauseUntil = Number.isFinite(pauseUntil) ? pauseUntil : null;
  runtimeStatus.pausedUntilRestart = !Number.isFinite(pauseUntil);
  runtimeStatus.lastOutcome = runtimeStatus.pausedUntilRestart ? "已暂停至下次启动" : "已临时暂停";
  return getScreenObserverStatus(now);
}

export function resumeScreenObservation(now = Date.now()): ScreenObserverStatus {
  pauseUntil = 0;
  runtimeStatus.pauseUntil = null;
  runtimeStatus.pausedUntilRestart = false;
  runtimeStatus.phase = runtimeStatus.enabled ? "waiting" : "disabled";
  runtimeStatus.lastOutcome = runtimeStatus.enabled ? "已恢复，等待下次检查" : "屏幕观察未启用";
  return getScreenObserverStatus(now);
}

export function getScreenObserverStatus(now = Date.now()): ScreenObserverStatus {
  if (pauseUntil > 0 && Number.isFinite(pauseUntil) && pauseUntil <= now) {
    pauseUntil = 0;
    runtimeStatus.pauseUntil = null;
    runtimeStatus.pausedUntilRestart = false;
    runtimeStatus.phase = runtimeStatus.enabled ? "waiting" : "disabled";
    runtimeStatus.lastOutcome = runtimeStatus.enabled ? "暂停已结束，等待下次检查" : "屏幕观察未启用";
  }
  return { ...runtimeStatus };
}

export function buildRecentScreenObservationContext(now = Date.now()): string {
  if (!latestObservation || now - latestObservation.observedAt > CONTEXT_MAX_AGE_MS) return "";
  const ageMinutes = Math.max(0, Math.round((now - latestObservation.observedAt) / 60_000));
  return [
    "【近期屏幕观察】",
    `约 ${ageMinutes} 分钟前：${latestObservation.text}`,
    "这只是可能已经过时的背景状态。仅在与当前对话相关时自然参考，不要声称仍在持续观看。",
  ].join("\n");
}

export async function runScreenObservationCycle(
  config: ScreenObserverConfig,
  deps: ScreenObserverDeps,
): Promise<"disabled" | "paused" | "waiting" | "busy" | "unconfigured" | "capture-failed" | "unchanged" | "observed"> {
  runtimeStatus.enabled = config.enabled;
  if (!config.enabled) {
    lastFingerprint = null;
    clearScreenObservation();
    runtimeStatus.phase = "disabled";
    runtimeStatus.lastOutcome = "屏幕观察未启用";
    return "disabled";
  }
  if (pauseUntil > 0) {
    getScreenObserverStatus(deps.now?.() ?? Date.now());
    if (pauseUntil > 0) {
      runtimeStatus.phase = "paused";
      return "paused";
    }
  }
  if (running) return "busy";

  const now = deps.now?.() ?? Date.now();
  const intervalMs = Math.max(1, Math.min(60, config.intervalMinutes)) * 60_000;
  if (lastCheckedAt > 0 && now - lastCheckedAt < intervalMs) {
    runtimeStatus.phase = "waiting";
    return "waiting";
  }

  const visionConfig = deps.getVisionConfig();
  if (!visionConfig) {
    runtimeStatus.phase = "unconfigured";
    runtimeStatus.lastOutcome = "视觉模型未配置";
    return "unconfigured";
  }

  running = true;
  lastCheckedAt = now;
  runtimeStatus.phase = "observing";
  runtimeStatus.lastCheckAt = now;
  runtimeStatus.lastOutcome = "正在分析屏幕变化";
  let capture: ScreenCapture | null = null;
  try {
    capture = await deps.captureScreen();
    if (!capture) {
      runtimeStatus.phase = "error";
      runtimeStatus.lastOutcome = "未获取到主屏幕画面";
      return "capture-failed";
    }

    const fingerprint = deps.createFingerprint(capture);
    const changed = !lastFingerprint || fingerprintChangeRatio(lastFingerprint, fingerprint) >= CHANGE_RATIO;
    lastFingerprint = fingerprint;
    if (!changed) {
      runtimeStatus.phase = "waiting";
      runtimeStatus.unchangedSkips += 1;
      runtimeStatus.lastOutcome = "画面变化很小，已跳过识别";
      return "unchanged";
    }

    runtimeStatus.visionCalls += 1;
    const text = await deps.analyzeImage(
      { base64: capture.base64, mime: capture.mime },
      OBSERVATION_PROMPT,
      visionConfig,
    );
    // A pause may have been requested while the visual API call was in flight.
    // Discard that late result so one-click pause takes effect immediately.
    if (pauseUntil > 0) {
      runtimeStatus.phase = "paused";
      return "paused";
    }
    recordScreenObservation(text, now);
    runtimeStatus.phase = "waiting";
    runtimeStatus.lastOutcome = "观察摘要已更新";
    return "observed";
  } catch (error) {
    console.warn("[ScreenObserver] observation failed:", error);
    runtimeStatus.phase = "error";
    runtimeStatus.lastOutcome = error instanceof Error ? error.message : "屏幕观察失败";
    return "capture-failed";
  } finally {
    capture = null;
    running = false;
  }
}

export function startScreenObserver(
  getConfig: () => ScreenObserverConfig,
  deps: ScreenObserverDeps,
): void {
  stopScreenObserver();
  const tick = () => void runScreenObservationCycle(getConfig(), deps);
  timer = setInterval(tick, CHECK_INTERVAL_MS);
  startupTimer = setTimeout(() => {
    startupTimer = null;
    tick();
  }, 5_000);
}

export function stopScreenObserver(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  running = false;
  lastCheckedAt = 0;
  lastFingerprint = null;
  clearScreenObservation();
  pauseUntil = 0;
  runtimeStatus = {
    phase: "disabled",
    enabled: false,
    pauseUntil: null,
    pausedUntilRestart: false,
    lastCheckAt: null,
    lastObservationAt: null,
    summary: "",
    unchangedSkips: 0,
    visionCalls: 0,
    lastOutcome: "尚未开始观察",
  };
}
