import { BrowserWindow } from "electron";
import path from "node:path";

let workbenchWindow: BrowserWindow | null = null;

function getWorkbenchWindow(): BrowserWindow | null {
  if (workbenchWindow?.isDestroyed()) workbenchWindow = null;
  return workbenchWindow;
}

export function createWorkbenchWindow(): void {
  const existing = getWorkbenchWindow();
  if (existing) {
    existing.focus();
    return;
  }

  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: "昔涟 · NovelAI 绘图",
    backgroundColor: "#1b1b22",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  workbenchWindow = window;

  if (process.env.VITE_DEV === "1") {
    void window.loadURL("http://localhost:5173/novelai/index.html");
  } else {
    void window.loadFile(
      path.join(__dirname, "..", "..", "..", "renderer", "novelai", "index.html"),
    );
  }
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (workbenchWindow === window) workbenchWindow = null;
  });
}

export function minimizeWorkbenchWindow(): void {
  getWorkbenchWindow()?.minimize();
}

export function closeWorkbenchWindow(): void {
  getWorkbenchWindow()?.close();
}
