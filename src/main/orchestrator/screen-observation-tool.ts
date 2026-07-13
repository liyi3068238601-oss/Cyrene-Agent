import type { VisionConfig, VisionImage } from "./vision-captioner";
import type { ToolDefinition } from "./tool-registry";

export interface ScreenCapture extends VisionImage {
  width: number;
  height: number;
}

export interface ScreenObservationDeps {
  captureScreen: () => Promise<ScreenCapture | null>;
  getVisionConfig: () => VisionConfig | null;
  analyzeImage: (image: VisionImage, question: string, config: VisionConfig) => Promise<string>;
  onObservation?: (text: string) => void;
}

const DEFAULT_QUESTION =
  "请查看当前屏幕，简洁说明正在显示的应用、主要内容、可见的重要文字，以及值得用户注意的异常。不要猜测看不清的内容。";

export function createScreenObservationTool(deps: ScreenObservationDeps): ToolDefinition {
  let inFlight = false;

  return {
    id: "screen_peek",
    name: "查看当前屏幕",
    description:
      "按需截取一次用户的主屏幕并用视觉模型回答问题。仅当用户明确询问当前屏幕、界面、弹窗、报错，或要求你‘看一眼屏幕’时调用；不要在普通聊天中调用，也不要连续重复调用。截图只在内存中短暂存在，不写入磁盘，工具返回后仅保留文字观察结果。",
    enabled: true,
    risk: "fs-read",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "需要根据当前屏幕回答的具体问题，尽量保留用户原意",
        },
      },
    },
    execute: async (args) => {
      if (inFlight) {
        return "屏幕观察正在进行中，请等待本次观察完成，不要重复调用。";
      }

      const config = deps.getVisionConfig();
      if (!config) {
        return "暂时无法查看屏幕：请先在 API 设置中启用并配置支持图片识别的视觉模型。";
      }

      inFlight = true;
      let capture: ScreenCapture | null = null;
      try {
        capture = await deps.captureScreen();
        if (!capture) {
          return "暂时无法查看屏幕：没有获取到主屏幕画面，请确认系统允许应用进行屏幕捕获。";
        }

        const rawQuestion = typeof args.question === "string" ? args.question.trim() : "";
        const question = rawQuestion.slice(0, 1_000) || DEFAULT_QUESTION;
        const result = await deps.analyzeImage(
          { base64: capture.base64, mime: capture.mime },
          question,
          config,
        );
        deps.onObservation?.(result);

        return `屏幕观察结果（本次截图未保存）：\n${result}`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `屏幕观察失败：${message}`;
      } finally {
        // Drop the only long-lived reference as soon as visual analysis finishes.
        capture = null;
        inFlight = false;
      }
    },
  };
}
