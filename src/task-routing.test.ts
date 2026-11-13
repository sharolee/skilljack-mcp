import { describe, it, expect } from "vitest";
import {
  scoreTaskAgainstDomains,
  suggestDomainsForTask,
  TASK_MATCH_MIN_SCORE,
  type DomainRouting,
  type RoutedDomain,
} from "./domain-router.js";

/** Pure-function tests for the task -> domain scorer; no filesystem or MCP. */
function routed(
  name: string,
  triggers: string[],
  antiTriggers: string[] = [],
  description = ""
): RoutedDomain {
  return { name, description, triggers, antiTriggers, skills: [] };
}

function routing(domains: RoutedDomain[], enabled = true): DomainRouting {
  return { enabled, globalSkills: [], domains, warnings: [], mapPath: null };
}

describe("scoreTaskAgainstDomains", () => {
  it("scores CJK triggers higher than ASCII ones and sorts by score", () => {
    const r = routing([
      routed("design", ["页面", "UI"]),
      routed("test", ["Playwright", "E2E"]),
    ]);
    const scored = scoreTaskAgainstDomains(r, "把这个页面做得紧凑一点");
    expect(scored[0].name).toBe("design");
    expect(scored[0].score).toBe(3);
    expect(scored[0].hits).toEqual(["页面"]);
    expect(scored[1].score).toBe(0);
  });

  it("matches ASCII case-insensitively at word boundaries", () => {
    const r = routing([routed("test", ["playwright", "e2e"])]);
    expect(scoreTaskAgainstDomains(r, "Add a PLAYWRIGHT e2e case")[0].score).toBe(4);
  });

  it("does not let plain ASCII triggers match inside longer words", () => {
    const r = routing([routed("design", ["design"])]);
    expect(scoreTaskAgainstDomains(r, "the designer refactored it")[0].score).toBe(0);
    expect(scoreTaskAgainstDomains(r, "design a page")[0].score).toBe(2);
  });

  it("still matches punctuated tech terms literally", () => {
    const r = routing([routed("architecture", ["Next.js", "React"])]);
    expect(scoreTaskAgainstDomains(r, "our Next.js app")[0].hits).toContain("Next.js");
  });

  it("vetoes a domain when any antiTrigger matches", () => {
    const r = routing([
      routed("design", ["界面", "设计"], ["单元测试"]),
      routed("test", ["测试"]),
    ]);
    const scored = scoreTaskAgainstDomains(r, "写单元测试，不要做界面设计");
    const design = scored.find((m) => m.name === "design")!;
    expect(design.blocked).toBe(true);
    expect(design.score).toBe(0);
    expect(design.antiHits).toEqual(["单元测试"]);
    expect(scored.find((m) => m.name === "test")!.score).toBe(3);
  });

  it("gives weak evidence from the domain description when not vetoed", () => {
    const r = routing([routed("docs", [], [], "README writing guide")]);
    const scored = scoreTaskAgainstDomains(r, "please update the README");
    expect(scored[0].score).toBeGreaterThan(0);
    expect(scored[0].weakHits.length).toBeGreaterThan(0);
  });

  it("returns a stable order for equal scores", () => {
    const r = routing([routed("zeta", ["页面"]), routed("alpha", ["页面"])]);
    expect(scoreTaskAgainstDomains(r, "页面").map((m) => m.name)).toEqual(["alpha", "zeta"]);
  });
});

describe("suggestDomainsForTask", () => {
  it("returns the winner with its resolved domain object", () => {
    const r = routing([
      routed("design", ["页面"]),
      routed("motion", ["动效", "spring"]),
    ]);
    const suggestions = suggestDomainsForTask(r, "给按钮加 spring 动效");
    expect(suggestions.map((m) => m.name)).toEqual(["motion"]);
    expect(suggestions[0].domain.name).toBe("motion");
  });

  it("requires the minimum score so a single weak word is not enough", () => {
    const r = routing([routed("design", ["UI"])]);
    expect(suggestDomainsForTask(r, "tidy the UI")).toEqual([]);
    expect(TASK_MATCH_MIN_SCORE).toBe(3);
  });

  it("drops a runner-up that is far behind the winner", () => {
    const r = routing([
      routed("test", ["测试", "用例", "Playwright"]),
      routed("design", ["页面"]),
    ]);
    expect(suggestDomainsForTask(r, "补一个测试用例，别管页面").map((m) => m.name)).toEqual([
      "test",
    ]);
  });

  it("keeps a genuinely close runner-up as also_relevant", () => {
    const r = routing([
      routed("architecture", ["React", "组件库"]),
      routed("design", ["组件", "设计"]),
    ]);
    expect(suggestDomainsForTask(r, "React 组件库的设计").map((m) => m.name)).toContain(
      "design"
    );
  });

  it("never suggests a vetoed domain", () => {
    const r = routing([routed("design", ["界面设计"], ["单元测试"])]);
    expect(suggestDomainsForTask(r, "单元测试与界面设计")).toEqual([]);
  });

  it("fails open to an empty result when routing is off or unconfigured", () => {
    expect(suggestDomainsForTask(routing([routed("design", ["页面"])], false), "页面")).toEqual([]);
    expect(suggestDomainsForTask(routing([], true), "页面")).toEqual([]);
    expect(suggestDomainsForTask(routing([routed("design", ["页面"])]), "")).toEqual([]);
  });
});
