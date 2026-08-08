import { app, ipcMain } from "electron";
import path from "node:path";
import { channelManager } from "./channels/manager";
import { toolRegistry } from "./orchestrator/tool-registry";
import { loadGeneralSettings, saveGeneralSettings } from "./settings/settings-facade";
import { loadModelSettings } from "./settings/model-settings";
import { pluginTranslateText } from "./plugin-llm";
import { PluginManager } from "../plugins/manager";

/**
 * 功能插件的主进程装配入口。
 *
 * 插件框架本身保持独立；这里仅把 Electron、工具、渠道、设置和 LLM
 * 这些应用级依赖接到框架上，避免它们重新散落进庞大的 index.ts。
 */
export async function startPluginRuntime(): Promise<PluginManager> {
  const userPluginRoot = path.join(app.getPath("userData"), "plugins");
  const manager = new PluginManager({
    scanRoots: [path.join(__dirname, "..", "plugins"), userPluginRoot],
    storageRoot: userPluginRoot,
    runtime: {
      toolRegistry,
      channelManager,
      registerIpc: (channel, handler) => {
        ipcMain.handle(channel, (_event, ...args: unknown[]) => handler(...args));
      },
      unregisterIpc: (channel) => ipcMain.removeHandler(channel),
      appEvents: {
        on: (event, callback) => app.on(event, callback),
        off: (event, callback) => app.removeListener(event, callback),
      },
      llm: {
        translateText: (messages) => pluginTranslateText(messages, loadModelSettings()),
      },
    },
    loadEnabledMap: () => loadGeneralSettings().plugins,
    saveEnabledMap: (plugins) => {
      saveGeneralSettings({ plugins });
    },
  });
  await manager.start();
  return manager;
}
