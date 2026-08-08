import type { CyrenePlugin } from "../types";
import { NOVELAI } from "./channels";
import { registerNovelAi, unregisterNovelAi } from "./service";
import {
  closeWorkbenchWindow,
  createWorkbenchWindow,
  minimizeWorkbenchWindow,
} from "./workbench";

export const novelaiPlugin: CyrenePlugin = {
  open() {
    createWorkbenchWindow();
  },
  register(ctx) {
    ctx.log("NovelAI 插件注册");
    ctx.registerIpc("status", () => ({
      id: "novelai",
      version: "0.1.0",
      ok: true,
    }));
    ctx.registerIpc(NOVELAI.OPEN_WORKBENCH, () => {
      createWorkbenchWindow();
      return { ok: true };
    });
    ctx.registerIpc(NOVELAI.MINIMIZE, () => {
      minimizeWorkbenchWindow();
      return { ok: true };
    });
    ctx.registerIpc(NOVELAI.CLOSE, () => {
      closeWorkbenchWindow();
      return { ok: true };
    });
    registerNovelAi(ctx);
  },
  unregister() {
    closeWorkbenchWindow();
    unregisterNovelAi();
  },
};

export default novelaiPlugin;
