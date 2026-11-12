import { describe, expect, it } from "vitest";

import { createEmbedValidator, matchesHostPattern } from "../intranet/embeds";

describe("intranet embeds (E2)", () => {
  it("matches hosts, wildcards and ports of https URLs only", () => {
    const url = (value: string) => new URL(value);
    expect(
      matchesHostPattern(
        url("https://wiki.intranet.example/x"),
        "wiki.intranet.example",
      ),
    ).toBe(true);
    expect(
      matchesHostPattern(
        url("http://wiki.intranet.example/x"),
        "wiki.intranet.example",
      ),
    ).toBe(false);
    expect(
      matchesHostPattern(
        url("https://a.b.intranet.example"),
        "*.intranet.example",
      ),
    ).toBe(true);
    // the bare domain is not below itself
    expect(
      matchesHostPattern(url("https://intranet.example"), "*.intranet.example"),
    ).toBe(false);
    expect(
      matchesHostPattern(
        url("https://evilintranet.example"),
        "*.intranet.example",
      ),
    ).toBe(false);
    expect(
      matchesHostPattern(
        url("https://grafana.intranet.example:8443/d/1"),
        "grafana.intranet.example:8443",
      ),
    ).toBe(true);
    expect(
      matchesHostPattern(
        url("https://grafana.intranet.example/d/1"),
        "grafana.intranet.example:8443",
      ),
    ).toBe(false);
  });

  it("leaves external services to the editor only if they are switched on", () => {
    const internal = createEmbedValidator({
      allowedHosts: ["wiki.intranet.example"],
      external: false,
    }) as (link: string) => boolean | undefined;
    expect(internal("https://wiki.intranet.example/page")).toBe(true);
    expect(internal("https://www.youtube.com/watch?v=abc")).toBe(false);
    expect(internal("not a url")).toBe(false);

    const withExternal = createEmbedValidator({
      allowedHosts: [],
      external: true,
    }) as (link: string) => boolean | undefined;
    expect(withExternal("https://www.youtube.com/watch?v=abc")).toBeUndefined();
  });
});
