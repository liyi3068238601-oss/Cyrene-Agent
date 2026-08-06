import type { ChannelAdapter } from "../main/channels/adapters/base";
import type { ToolDefinition } from "../main/orchestrator/tool-registry";
import { createPluginStorage } from "./storage";
import type { ChannelManagerLike, PluginContext, PluginDeps, PluginManifest } from "./types";

export interface PluginRuntime {
  toolRegistry: {
    register(tool: ToolDefinition): void;
    unregister(id: string): boolean;
    /** 供冲突告警使用；不存在时跳过 */
    getById?(id: string): ToolDefinition | undefined;
  };
  channelManager: ChannelManagerLike;
  registerIpc: (channel: string, handler: (...args: unknown[]) => unknown) => void;
  unregisterIpc: (channel: string) => void;
  appEvents: {
    on(evt: "before-quit", cb: () => void): void;
    off?(evt: "before-quit", cb: () => void): void;
  };
}

interface DisposableContext extends PluginContext {
  /** 框架内部：卸载插件时统一清理已注册资源 */
  dispose(): void;
}

export function createContext(
  id: string,
  storageRoot: string,
  runtime: PluginRuntime,
  declaredDeps?: PluginManifest["deps"],
): DisposableContext {
  const registeredTools = new Set<string>();
  const registeredIpc = new Set<string>();
  const registeredAdapters = new Set<string>();
  const beforeQuitCbs: Array<() => void> = [];

  // deps 白名单生效：只有 manifest.deps 声明的依赖才会注入
  const deps: PluginDeps = {};
  if (declaredDeps?.includes("channels")) {
    deps.channels = { channelManager: runtime.channelManager };
  }

  const ctx: PluginContext = {
    id,
    registerTool(tool: ToolDefinition) {
      const expectedPrefix = `${id}_`;
      if (!tool.id.startsWith(expectedPrefix)) {
        throw new Error(`插件工具 id 必须以 "${expectedPrefix}" 开头: ${tool.id}`);
      }
      const existing = runtime.toolRegistry.getById?.(tool.id);
      if (existing) {
        console.warn(`[plugin:${id}] 工具 id 冲突，覆盖已注册工具: ${tool.id}`);
      }
      runtime.toolRegistry.register(tool);
      registeredTools.add(tool.id);
    },
    unregisterTool(toolId: string) {
      runtime.toolRegistry.unregister(toolId);
      registeredTools.delete(toolId);
    },
    registerIpc(channel: string, handler: (...args: unknown[]) => unknown) {
      const full = `plugin:${id}:${channel}`;
      runtime.registerIpc(full, handler);
      registeredIpc.add(full);
    },
    unregisterIpc(channel: string) {
      const full = `plugin:${id}:${channel}`;
      runtime.unregisterIpc(full);
      registeredIpc.delete(full);
    },
    async registerChannelAdapter(adapter: ChannelAdapter) {
      runtime.channelManager.register(adapter);
      try {
        await runtime.channelManager.startOne(adapter.id);
      } catch (err) {
        // 半成功回滚：start 失败时撤销已注册的 adapter，避免 dispose 遗漏
        await runtime.channelManager.unregister(adapter.id);
        throw err;
      }
      registeredAdapters.add(adapter.id);
    },
    async unregisterChannelAdapter(channelId: string) {
      await runtime.channelManager.unregister(channelId);
      registeredAdapters.delete(channelId);
    },
    storage: createPluginStorage(storageRoot),
    deps,
    log(...args: unknown[]) {
      console.log(`[plugin:${id}]`, ...args);
    },
  };

  const onBeforeQuit = () => {
    for (const cb of beforeQuitCbs) cb();
  };
  runtime.appEvents.on("before-quit", onBeforeQuit);

  return Object.assign(ctx, {
    dispose() {
      runtime.appEvents.off?.("before-quit", onBeforeQuit);
      for (const toolId of registeredTools) runtime.toolRegistry.unregister(toolId);
      registeredTools.clear();
      for (const channel of registeredIpc) runtime.unregisterIpc(channel);
      registeredIpc.clear();
      for (const adapterId of registeredAdapters) {
        void runtime.channelManager.unregister(adapterId);
      }
      registeredAdapters.clear();
    },
  });
}
