import { afterEach, describe, expect, it, vi } from "vitest";
import { diagnoseImageError, getImageProvider, getProviderCapabilities, upscaleWithGateway } from "./providers";
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
  it("turns model routing failures into actionable diagnostics",()=>{expect(diagnoseImageError(400,"No available channel for model nai-v4.5-full (request id: abc123)")).toContain("渠道映射");expect(diagnoseImageError(400,"No available channel for model nai-v4.5-full (request id: abc123)")).toContain("abc123")});
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

  it("keeps legacy vibe fields while sending multiple references", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("multi").toString("base64") }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await getImageProvider("novelai-gateway").generate(baseConfig, {
      ...input, referenceMode: "vibe", referenceImage: "first",
      referenceImages: [
        { image: "first", strength: 0.4, informationExtracted: 0.8 },
        { image: "second", strength: 0.7, informationExtracted: 1 },
      ],
    });
    const payload=JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(payload.reference_image).toBe("first");
    expect(payload.reference_images).toEqual(["first","second"]);
    expect(payload.reference_strengths).toEqual([0.4,0.7]);
    expect(payload.reference_information_extracted_multiple).toEqual([0.8,1]);
  });

  it("sends an explicit black and white mask to the gateway inpainting endpoint", async () => {
    const fetchMock=vi.fn().mockResolvedValue(new Response(JSON.stringify({data:[{b64_json:Buffer.from("edited").toString("base64")}]}),{status:200}));vi.stubGlobal("fetch",fetchMock);
    await getImageProvider("novelai-gateway").generate(baseConfig,{...input,referenceMode:"inpaint",referenceImage:"source",maskImage:"mask",referenceStrength:0.55});
    expect(fetchMock.mock.calls[0][0]).toBe("https://relay.example/v1/images/inpainting");
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toMatchObject({image:"source",mask:"mask",strength:0.55});
  });

  it("routes outpaint through the inpainting endpoint", async () => {
    const fetchMock=vi.fn().mockResolvedValue(new Response(JSON.stringify({data:[{b64_json:Buffer.from("wide").toString("base64")}]}),{status:200}));vi.stubGlobal("fetch",fetchMock);
    await getImageProvider("novelai-gateway").generate(baseConfig,{...input,referenceMode:"outpaint",referenceImage:"expanded",maskImage:"border-mask"});
    expect(fetchMock.mock.calls[0][0]).toBe("https://relay.example/v1/images/inpainting");
  });

  it("sends structured V4 character prompts and coordinates", async () => {
    const fetchMock=vi.fn().mockResolvedValue(new Response(JSON.stringify({data:[{b64_json:Buffer.from("duo").toString("base64")}]}),{status:200}));vi.stubGlobal("fetch",fetchMock);
    await getImageProvider("novelai-gateway").generate(baseConfig,{...input,characters:[{id:"a",name:"A",prompt:"pink hair",negativePrompt:"blue hair",x:.25,y:.55},{id:"b",name:"B",prompt:"blue hair",negativePrompt:"pink hair",x:.75,y:.55}]});
    const payload=JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));expect(payload.use_coords).toBe(true);expect(payload.characterPrompts).toHaveLength(2);expect(payload.v4_prompt.caption.char_captions[1].centers[0]).toEqual({x:.75,y:.55});
  });

  it("calls the gateway binary upscale endpoint", async () => {
    const fetchMock=vi.fn().mockResolvedValue(new Response(Buffer.from("png"),{status:200,headers:{"content-type":"image/png"}}));vi.stubGlobal("fetch",fetchMock);
    const result=await upscaleWithGateway(baseConfig,"source",832,1216,2);expect(fetchMock.mock.calls[0][0]).toBe("https://relay.example/v1/images/upscale");expect(result.bytes.toString()).toBe("png");
  });
});
