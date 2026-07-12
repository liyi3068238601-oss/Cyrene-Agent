export type ImageProviderKind =
  | "novelai-gateway"
  | "openai-images"
  | "chat-completions-image"
  | "novelai-native"
  | "async-task";

export interface ImageProviderCapabilities {
  negativePrompt: boolean;
  dimensions: boolean;
  steps: boolean;
  scale: boolean;
  sampler: boolean;
  seed: boolean;
  img2img: boolean;
  vibe: boolean;
  directorReference: boolean;
  multiCharacter: boolean;
}

export interface NovelAiConfig {
  providerMode: ImageProviderKind;
  gatewayUrl: string;
  apiKey: string;
  model: string;
  defaultNegativePrompt: string;
  modelsPath: string;
  generationPath: string;
  asyncResultPath: string;
  pollIntervalMs: number;
  characterName: string;
  characterBaseTags: string;
  characterFixedTags: string;
  characterNegativeTags: string;
  photoStyleTags: string;
  drawingStyleTags: string;
  wardrobeEnabled: boolean;
  activeOutfitId: string;
  outfits: OutfitPreset[];
}

export interface OutfitPreset { id: string; name: string; description: string; tags: string }
export type VisualMode = "photo" | "drawing";

export interface ImageGenerationInput {
  prompt: string;
  negativePrompt: string;
  model: string;
  width: number;
  height: number;
  steps: number;
  scale: number;
  sampler: string;
  seed: number;
  referenceMode: "none" | "img2img" | "vibe" | "director-character" | "director-style" | "director-both";
  referenceImage?: string;
  referenceStrength: number;
  referenceInformationExtracted: number;
}

export interface ProviderImageResult {
  bytes: Buffer;
  mimeType: string;
}

export interface ImageProvider {
  readonly kind: ImageProviderKind;
  readonly capabilities: ImageProviderCapabilities;
  listModels(config: NovelAiConfig): Promise<string[]>;
  test(config: NovelAiConfig): Promise<void>;
  generate(config: NovelAiConfig, input: ImageGenerationInput): Promise<ProviderImageResult>;
}
