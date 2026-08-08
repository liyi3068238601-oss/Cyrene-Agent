import type { CyrenePlugin } from "../types";
import { NOVELAI } from "./channels";

export const novelaiPlugin: CyrenePlugin = {
  register(ctx) {
    ctx.log("NovelAI 插件注册");
    ctx.registerIpc("status", () => ({
      id: "novelai",
      version: "0.1.0",
      ok: true,
    }));
    ctx.registerIpc(NOVELAI.OPEN_WORKBENCH, () => ({
      ok: false,
      error: "工作台尚未接入",
    }));
  },
  unregister() {
    console.log("[plugin:novelai] 已卸载");
  },
};

export default novelaiPlugin;
