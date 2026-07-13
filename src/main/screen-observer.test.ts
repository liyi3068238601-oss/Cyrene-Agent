import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildRecentScreenObservationContext,
  fingerprintChangeRatio,
  getLatestScreenObservation,
  getScreenObserverStatus,
  pauseScreenObservation,
  resumeScreenObservation,
  runScreenObservationCycle,
  stopScreenObserver,
} from "./screen-observer";
import type { ScreenCapture } from "./orchestrator/screen-observation-tool";

const capture: ScreenCapture = {
  base64: "cG5n",
  mime: "image/png",
  width: 1920,
  height: 1080,
};
const vision = { baseUrl: "https://vision.example/v1", apiKey: "key", model: "vision" };

describe("screen observer", () => {
  beforeEach(() => stopScreenObserver());

  it("computes fingerprint changes", () => {
    expect(fingerprintChangeRatio(new Uint8Array([0, 1, 0, 1]), new Uint8Array([0, 1, 1, 0]))).toBe(0.5);
  });

  it("observes a changed screen and exposes only text context", async () => {
    const analyzeImage = vi.fn(async () => "用户正在编辑代码。") ;
    const status = await runScreenObservationCycle(
      { enabled: true, intervalMinutes: 1 },
      {
        captureScreen: async () => capture,
        getVisionConfig: () => vision,
        analyzeImage,
        createFingerprint: () => new Uint8Array([0, 1, 0, 1, 1, 0, 1, 0]),
        now: () => 1_000_000,
      },
    );

    expect(status).toBe("observed");
    expect(getLatestScreenObservation()).toEqual({ text: "用户正在编辑代码。", observedAt: 1_000_000 });
    expect(buildRecentScreenObservationContext(1_060_000)).toContain("用户正在编辑代码");
    expect(buildRecentScreenObservationContext(1_060_000)).not.toContain(capture.base64);
  });

  it("skips visual analysis when the fingerprint is unchanged", async () => {
    const analyzeImage = vi.fn(async () => "第一次观察");
    const deps = {
      captureScreen: async () => capture,
      getVisionConfig: () => vision,
      analyzeImage,
      createFingerprint: () => new Uint8Array(64),
    };

    expect(await runScreenObservationCycle({ enabled: true, intervalMinutes: 1 }, { ...deps, now: () => 1_000_000 })).toBe("observed");
    expect(await runScreenObservationCycle({ enabled: true, intervalMinutes: 1 }, { ...deps, now: () => 1_061_000 })).toBe("unchanged");
    expect(analyzeImage).toHaveBeenCalledTimes(1);
  });

  it("clears cached context when disabled", async () => {
    const status = await runScreenObservationCycle(
      { enabled: false, intervalMinutes: 5 },
      {
        captureScreen: vi.fn(),
        getVisionConfig: () => vision,
        analyzeImage: vi.fn(),
        createFingerprint: vi.fn(),
      },
    );

    expect(status).toBe("disabled");
    expect(getLatestScreenObservation()).toBeNull();
  });

  it("supports timed pause, automatic expiry, and resume", () => {
    pauseScreenObservation(10 * 60_000, 1_000_000);
    expect(getScreenObserverStatus(1_100_000).phase).toBe("paused");
    expect(getScreenObserverStatus(1_601_000).phase).toBe("disabled");

    pauseScreenObservation(null, 2_000_000);
    expect(getScreenObserverStatus(99_000_000).pausedUntilRestart).toBe(true);
    expect(resumeScreenObservation(99_000_000).phase).toBe("disabled");
  });
});
