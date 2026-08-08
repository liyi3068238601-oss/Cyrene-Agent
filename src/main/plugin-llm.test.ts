import { describe, expect, it } from "vitest";
import { pluginTranslateText } from "./plugin-llm";

describe("pluginTranslateText", () => {
  it("复用当前主模型配置发送非流式文本请求", async () => {
    let capturedBody: unknown;
    let calls = 0;
    const fetchImpl = (async (_input: unknown, init?: { body?: unknown }) => {
      calls += 1;
      capturedBody = init?.body;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "pink hair, purple eyes" } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await pluginTranslateText(
      [{ role: "user", content: "粉色头发，紫色眼睛" }],
      {
        provider: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5-mini",
        apiKey: "secret",
        explicitTransport: "openai",
      },
      fetchImpl,
    );

    expect(result).toBe("pink hair, purple eyes");
    expect(calls).toBe(1);
    expect(JSON.parse(String(capturedBody))).toMatchObject({
      model: "gpt-5-mini",
      stream: false,
    });
  });

  it("没有 API Key 时拒绝请求", async () => {
    await expect(
      pluginTranslateText(
        [{ role: "user", content: "你好" }],
        { provider: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-5-mini", apiKey: "" },
      ),
    ).rejects.toThrow(/API Key/);
  });
});
