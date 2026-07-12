import { afterEach, describe, expect, it, vi } from "vitest";
import { getImageProvider, getProviderCapabilities } from "./providers";
import type { ImageGenerationInput, NovelAiConfig } from "./types";

const baseConfig: NovelAiConfig = {
  providerMode: "novelai-gateway",
  gatewayUrl: "https://relay.example/v1",
  apiKey: "secret",
  model: "nai-v4.5-full",
  defaultNegativePrompt: "bad hands",
  modelsPath: "/v1/models",
  generationPath: "/v1/images/generations",
  asyncResultPath: "/api/get_result/{id}",
  pollIntervalMs: 500,
  characterName: "昔涟",
  characterBaseTags: "pink hair",
  characterFixedTags: "purple eyes",
  characterNegativeTags: "wrong hair",
  photoStyleTags: "anime illustration",
  drawingStyleTags: "sketch",
  wardrobeEnabled: true,
  activeOutfitId: "default",
  outfits: [{ id: "default", name: "默认", description: "", tags: "white dress" }],
};

const input: ImageGenerationInput = {
  prompt: "1girl, pink hair",
  negativePrompt: "bad hands",
  model: "nai-v4.5-full",
  width: 832,
  height: 1216,
  steps: 28,
  scale: 5,
  sampler: "k_euler_ancestral",
  seed: 42,
  referenceMode: "none",
  referenceStrength: 0.7,
  referenceInformationExtracted: 1,
};

afterEach(() => vi.unstubAllGlobals());

describe("image providers", () => {
  it("normalizes a /v1 base URL and sends NovelAI parameters to the gateway", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: Buffer.from("png").toString("base64") }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getImageProvider("novelai-gateway").generate(baseConfig, input);
    expect(result.bytes.toString()).toBe("png");
    expect(fetchMock.mock.calls[0][0]).toBe("https://relay.example/v1/images/generations");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(String(init.body));
    expect(payload).toMatchObject({ negative_prompt: "bad hands", steps: 28, scale: 5, seed: 42 });
  });

  it("extracts a markdown image URL from chat completions", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "完成：![result](https://cdn.example/image.png)" } }],
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(Buffer.from("image"), { status: 200, headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", fetchMock);
    const config = { ...baseConfig, providerMode: "chat-completions-image" as const, generationPath: "/v1/chat/completions" };

    const result = await getImageProvider("chat-completions-image").generate(config, input);
    expect(result.bytes.toString()).toBe("image");
    expect(fetchMock.mock.calls[1][0]).toBe("https://cdn.example/image.png");
  });

  it("declares protocol-specific capabilities", () => {
    expect(getProviderCapabilities("openai-images").sampler).toBe(false);
    expect(getProviderCapabilities("novelai-native").sampler).toBe(true);
    expect(getProviderCapabilities("novelai-native").vibe).toBe(true);
    expect(getProviderCapabilities("novelai-gateway").directorReference).toBe(false);
  });

  it("uses the gateway vibe-transfer endpoint for a reference image", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: Buffer.from("vibe").toString("base64") }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await getImageProvider("novelai-gateway").generate(baseConfig, {
      ...input,
      referenceMode: "vibe",
      referenceImage: Buffer.from("reference").toString("base64"),
      referenceStrength: 0.6,
      referenceInformationExtracted: 0.9,
    });
    expect(fetchMock.mock.calls[0][0]).toBe("https://relay.example/v1/images/vibe-transfer");
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toMatchObject({
      reference_strength: 0.6,
      reference_information_extracted: 0.9,
    });
  });
});
