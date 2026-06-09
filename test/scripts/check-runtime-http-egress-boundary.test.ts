// Runtime HTTP egress boundary tests cover raw fetch and retired guard checks.
import { describe, expect, it } from "vitest";
import { collectRuntimeHttpEgressBoundaryViolations } from "../../scripts/check-runtime-http-egress-boundary.mjs";

function collect(files: Record<string, string>): string[] {
  return collectRuntimeHttpEgressBoundaryViolations(Object.keys(files), (file) => {
    const source = files[file];
    if (source === undefined) {
      throw new Error(`missing fixture: ${file}`);
    }
    return source;
  });
}

describe("check-runtime-http-egress-boundary", () => {
  it("catches representative raw runtime fetches", () => {
    const violations = collect({
      "src/agents/example-runtime.ts":
        "export async function run(url: string) { return fetch(url); }",
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("raw runtime fetch must use src/infra/net/egress-fetch.ts");
  });

  it("allows documented transport exceptions", () => {
    const violations = collect({
      "extensions/telegram/src/fetch.ts":
        'import { fetch as undiciFetch } from "undici"; export async function run(url: string) { return undiciFetch(url); }',
    });

    expect(violations).toEqual([]);
  });

  it("catches retired guard vocabulary", () => {
    const violations = collect({
      "src/agents/example-runtime.ts":
        'import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime"; export const run = fetchWithSsrFGuard;',
    });

    expect(violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("retired fetchWithSsrFGuard vocabulary"),
        expect.stringContaining("retired openclaw/plugin-sdk/ssrf-runtime vocabulary"),
      ]),
    );
  });

  it("catches old per-call guard plumbing", () => {
    const violations = collect({
      "src/agents/example-runtime.ts":
        "export async function run(url: string, ssrfPolicy: unknown) { return fetchWithResponseRelease({ url, ssrfPolicy }); }",
    });

    expect(violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("retired generic ssrfPolicy fetch plumbing vocabulary"),
      ]),
    );
  });
});
