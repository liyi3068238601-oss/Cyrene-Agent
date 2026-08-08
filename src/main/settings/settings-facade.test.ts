import { describe, expect, it } from "vitest";
import { normalizeGeneralSettings } from "./settings-facade";

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
