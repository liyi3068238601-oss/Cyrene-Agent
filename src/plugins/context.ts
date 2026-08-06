import type { ChannelAdapter } from "../main/channels/adapters/base";
import type { ToolDefinition } from "../main/orchestrator/tool-registry";
import { createPluginStorage } from "./storage";
import type { ChannelManagerLike, PluginContext, PluginDeps } from "./types";

export interface PluginRuntime {
  toolRegistry: {
    register(tool: ToolDefinition): void;
    unregister(id: string): boolean;
  };
  channelManager: ChannelManagerLike;
  registerIpc: (channel: string, handler: (...args: unknown[]) => unknown) => void;
  unregisterIpc: (channel: string) => void;
  appEvents: {
    on(evt: "before-quit", cb: () => void): void;
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
): DisposableContext {
  const registeredTools = new Set<string>();
  const registeredIpc = new Set<string>();
  const registeredAdapters = new Set<string>();
  const beforeQuitCbs: Array<() => void> = [];

  const deps: PluginDeps = {
    channels: { channelManager: runtime.channelManager },
  };

  const ctx: PluginContext = {
    id,
    registerTool(tool: ToolDefinition) {
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
      await runtime.channelManager.startOne(adapter.id);
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

  runtime.appEvents.on("before-quit", () => {
    for (const cb of beforeQuitCbs) cb();
  });

  return Object.assign(ctx, {
    dispose() {
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
