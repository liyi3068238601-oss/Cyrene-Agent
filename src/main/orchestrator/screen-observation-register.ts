import { captureScreen } from "../game-bot/screenshot";
import { captionImage, type VisionConfig } from "./vision-captioner";
import { toolRegistry } from "./tool-registry";
import { createScreenObservationTool } from "./screen-observation-tool";
import { recordScreenObservation } from "../screen-observer";

let visionConfigGetter: () => VisionConfig | null = () => null;

export function setScreenObservationVisionConfigGetter(
  getter: () => VisionConfig | null,
): void {
  visionConfigGetter = getter;
}

toolRegistry.register(createScreenObservationTool({
  captureScreen,
  getVisionConfig: () => visionConfigGetter(),
  analyzeImage: captionImage,
  onObservation: recordScreenObservation,
}));
