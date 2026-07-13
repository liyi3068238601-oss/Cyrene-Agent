import { describe, expect, it, vi } from "vitest";
import { createScreenObservationTool, type ScreenCapture } from "./screen-observation-tool";
import type { VisionConfig } from "./vision-captioner";

const config: VisionConfig = {
  baseUrl: "https://vision.example/v1",
  apiKey: "test-key",
  model: "vision-model",
};

const capture: ScreenCapture = {
  base64: "cG5n",
  mime: "image/png",
  width: 1920,
  height: 1080,
};

describe("screen observation tool", () => {
  it("captures once and returns the visual model result", async () => {
    const captureScreen = vi.fn(async () => capture);
    const analyzeImage = vi.fn(async () => "屏幕上打开了聊天窗口。") ;
    const tool = createScreenObservationTool({
      captureScreen,
      getVisionConfig: () => config,
      analyzeImage,
    });

    const result = await tool.execute({ question: "屏幕上有什么？" });

    expect(result).toContain("屏幕上打开了聊天窗口");
    expect(result).toContain("本次截图未保存");
    expect(captureScreen).toHaveBeenCalledTimes(1);
    expect(analyzeImage).toHaveBeenCalledWith(
      { base64: capture.base64, mime: capture.mime },
      "屏幕上有什么？",
      config,
    );
  });

  it("does not capture when no vision model is configured", async () => {
    const captureScreen = vi.fn(async () => capture);
    const tool = createScreenObservationTool({
      captureScreen,
      getVisionConfig: () => null,
      analyzeImage: vi.fn(),
    });

    const result = await tool.execute({});

    expect(result).toContain("配置支持图片识别的视觉模型");
    expect(captureScreen).not.toHaveBeenCalled();
  });

  it("reports a capture failure without invoking the visual model", async () => {
    const analyzeImage = vi.fn();
    const tool = createScreenObservationTool({
      captureScreen: async () => null,
      getVisionConfig: () => config,
      analyzeImage,
    });

    const result = await tool.execute({ question: "看看当前报错" });

    expect(result).toContain("没有获取到主屏幕画面");
    expect(analyzeImage).not.toHaveBeenCalled();
  });
});
