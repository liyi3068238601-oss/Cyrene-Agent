import { describe, expect, it } from "vitest";
import type { GeneralSettings } from "./general-settings";
import { normalizeGeneralSettings } from "./settings-facade";

describe("general LSP settings", () => {
  it("keeps valid user server overrides and safely drops malformed settings", () => {
    const settings = normalizeGeneralSettings({
      lspServerOverrides: [
        { id: "python-pyright", command: "basedpyright-langserver", args: ["--stdio"] },
        { id: "python-pyright", command: "duplicate" },
        { id: "unknown-server", command: "not-allowed" },
        { id: "gopls", command: "  " },
        { id: "typescript-language-server", initializationOptions: { preferences: { includeCompletionsForModuleExports: true } }, constructor: "unsafe" },
      ] as unknown as GeneralSettings["lspServerOverrides"],
    });

    expect(settings.lspServerOverrides).toEqual([
      { id: "python-pyright", command: "basedpyright-langserver", args: ["--stdio"] },
      { id: "typescript-language-server", initializationOptions: { preferences: { includeCompletionsForModuleExports: true } } },
    ]);
  });

  it("loads older settings without requiring an LSP migration", () => {
    expect(normalizeGeneralSettings({}).lspServerOverrides).toEqual([]);
  });
});

describe("normalizeGeneralSettings plugin state", () => {
  it("keeps boolean plugin switches when old settings are migrated", () => {
    const normalized = normalizeGeneralSettings({
      plugins: {
        novelai: true,
        disabledExample: false,
      },
    });

    expect(normalized.plugins).toEqual({
      novelai: true,
      disabledExample: false,
    });
  });

  it("falls back to an empty map for invalid plugin state", () => {
    const normalized = normalizeGeneralSettings({
      plugins: null as unknown as Record<string, boolean>,
    });

    expect(normalized.plugins).toEqual({});
  });
});
