// Channel entry resolution tests preserve canonical-id and alias collision semantics.
import { describe, expect, it } from "vitest";
import { resolveChannelEntry } from "./channel-entry-resolution.js";

const entries = [
  { id: "feishu", meta: { aliases: ["lark", "telegram", "shared"] } },
  { id: "telegram", meta: { aliases: ["tg", "shared"] } },
] as const;

describe("resolveChannelEntry", () => {
  it("normalizes canonical ids and aliases", () => {
    expect(resolveChannelEntry(" TELEGRAM ", entries)?.id).toBe("telegram");
    expect(resolveChannelEntry("Lark", entries)?.id).toBe("feishu");
  });

  it("prefers canonical ids over earlier aliases", () => {
    expect(resolveChannelEntry("telegram", entries)?.id).toBe("telegram");
  });

  it("keeps discovery order for duplicate aliases", () => {
    expect(resolveChannelEntry("shared", entries)?.id).toBe("feishu");
  });

  it("rejects blank and unknown targets", () => {
    expect(resolveChannelEntry(" ", entries)).toBeUndefined();
    expect(resolveChannelEntry("unknown", entries)).toBeUndefined();
  });
});
