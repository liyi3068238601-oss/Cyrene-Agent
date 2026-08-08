import { contextBridge, ipcRenderer } from "electron";
import { NOVELAI } from "./channels";

const channel = (name: string): string => `plugin:novelai:${name}`;

const novelaiApi = {
  minimize: () => ipcRenderer.invoke(channel(NOVELAI.MINIMIZE)),
  close: () => ipcRenderer.invoke(channel(NOVELAI.CLOSE)),
  loadConfig: () => ipcRenderer.invoke(channel(NOVELAI.LOAD_CONFIG)),
  saveConfig: (config: unknown) => ipcRenderer.invoke(channel(NOVELAI.SAVE_CONFIG), config),
  test: (config?: unknown) => ipcRenderer.invoke(channel(NOVELAI.TEST), config),
  capabilities: (kind: string) => ipcRenderer.invoke(channel(NOVELAI.CAPABILITIES), kind),
  models: (config?: unknown) => ipcRenderer.invoke(channel(NOVELAI.MODELS), config),
  generate: (input: unknown) => ipcRenderer.invoke(channel(NOVELAI.GENERATE), input),
  tasks: () => ipcRenderer.invoke(channel(NOVELAI.TASKS)),
  cancelTask: (id: string) => ipcRenderer.invoke(channel(NOVELAI.TASK_CANCEL), id),
  retryTask: (id: string) => ipcRenderer.invoke(channel(NOVELAI.TASK_RETRY), id),
  history: (offset = 0, limit = 40) =>
    ipcRenderer.invoke(channel(NOVELAI.HISTORY), offset, limit),
  image: (id: string) => ipcRenderer.invoke(channel(NOVELAI.GET_IMAGE), id),
  openOutput: () => ipcRenderer.invoke(channel(NOVELAI.OPEN_OUTPUT)),
  pickImage: () => ipcRenderer.invoke(channel(NOVELAI.PICK_IMAGE)),
  assets: () => ipcRenderer.invoke(channel(NOVELAI.ASSETS)),
  importAsset: () => ipcRenderer.invoke(channel(NOVELAI.ASSET_IMPORT)),
  deleteAsset: (id: string) => ipcRenderer.invoke(channel(NOVELAI.ASSET_DELETE), id),
  updateAsset: (id: string, patch: unknown) =>
    ipcRenderer.invoke(channel(NOVELAI.ASSET_UPDATE), id, patch),
  upscale: (id: string, scale: number) =>
    ipcRenderer.invoke(channel(NOVELAI.UPSCALE), id, scale),
  updateHistory: (id: string, patch: unknown) =>
    ipcRenderer.invoke(channel(NOVELAI.HISTORY_UPDATE), id, patch),
  deleteHistory: (id: string) =>
    ipcRenderer.invoke(channel(NOVELAI.HISTORY_DELETE), id),
  translatePrompt: (description: string) =>
    ipcRenderer.invoke(channel(NOVELAI.TRANSLATE_PROMPT), [
      {
        role: "system",
        content:
          "Convert the user's Chinese image description into concise NovelAI English comma-separated tags. Preserve subject, appearance, clothing, pose, expression, composition, environment, lighting and style. Output tags only; no explanation, Markdown, quotes, or roleplay.",
      },
      { role: "user", content: description },
    ]),
  onTasksChanged: (callback: (tasks: unknown[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, tasks: unknown[]) => callback(tasks);
    ipcRenderer.on(channel(NOVELAI.TASKS_CHANGED), listener);
    return () => ipcRenderer.removeListener(channel(NOVELAI.TASKS_CHANGED), listener);
  },
};

contextBridge.exposeInMainWorld("novelai", novelaiApi);
