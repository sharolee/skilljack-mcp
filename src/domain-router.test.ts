import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildDomainRouting,
  getDomainMapPath,
  readDomainMap,
  renderDomainIndex,
  routeSkills,
  type DomainMap,
} from "./domain-router.js";
import { createTestSkill, createTestSource } from "./__test-helpers__/helpers.js";
import { BUNDLED_SKILL_SOURCE } from "./skill-discovery.js";

const qualified = (base: string) =>
  createTestSkill({ name: `local__${base}`, baseName: base, source: createTestSource() });

describe("getDomainMapPath", () => {
  const savedArgv = process.argv;
  const mapEnv = "SKILLJACK_DOMAIN_MAP";
  const savedEnv = process.env[mapEnv];

  beforeEach(() => {
    process.argv = ["node", "index.js"];
    delete process.env[mapEnv];
  });
  afterEach(() => {
    process.argv = savedArgv;
    if (savedEnv === undefined) delete process.env[mapEnv];
    else process.env[mapEnv] = savedEnv;
  });

  it("honours --domain-map=<path> over the env var", () => {
    process.env[mapEnv] = "ignored.json";
    process.argv = ["node", "index.js", "--domain-map=./map.json", "/skills"];
    expect(getDomainMapPath()).toBe(path.resolve("./map.json"));
  });

  it("reads SKILLJACK_DOMAIN_MAP", () => {
    process.env[mapEnv] = "./from-env.json";
    expect(getDomainMapPath()).toBe(path.resolve("./from-env.json"));
  });

  it("returns null when explicitly disabled", () => {
    for (const off of ["off", "OFF", "0", "false", "none"]) {
      process.env[mapEnv] = off;
      expect(getDomainMapPath()).toBeNull();
    }
  });
});

describe("readDomainMap", () => {
  function withMap(source: unknown): string {
    const file = path.join(os.tmpdir(), `sj-domains-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file, typeof source === "string" ? source : JSON.stringify(source), "utf-8");
    return file;
  }

  it("parses domains with triggers, anti-triggers and descriptions", () => {
    const file = withMap({
      version: 1,
      domains: [
        {
          name: "design",
          description: "UI/UX",
          triggers: ["design", "UI"],
          antiTriggers: ["backend"],
          skills: ["a", "b"],
        },
      ],
    });
    const map = readDomainMap(file);
    fs.unlinkSync(file);
    expect(map.version).toBe(1);
    expect(map.domains).toHaveLength(1);
    expect(map.domains[0]).toMatchObject({
      name: "design",
      description: "UI/UX",
      triggers: ["design", "UI"],
      antiTriggers: ["backend"],
      skills: ["a", "b"],
    });
  });

  it("normalises non-string arrays and defaults optional fields", () => {
    const file = withMap({ domains: [{ name: "x", skills: ["a", 42, "", "b"], triggers: "not-array" }] });
    const map = readDomainMap(file);
    fs.unlinkSync(file);
    expect(map.domains[0].skills).toEqual(["a", "b"]);
    expect(map.domains[0].triggers).toEqual([]);
    expect(map.domains[0].description).toBe("");
  });

  it("rejects malformed JSON, a missing domains array and duplicate names", () => {
    const badJson = withMap("{ not json");
    expect(() => readDomainMap(badJson)).toThrow(/invalid JSON/);
    fs.unlinkSync(badJson);

    const noDomains = withMap({ version: 1 });
    expect(() => readDomainMap(noDomains)).toThrow(/"domains" array/);
    fs.unlinkSync(noDomains);

    const dup = withMap({ domains: [{ name: "a", skills: [] }, { name: "A", skills: [] }] });
    expect(() => readDomainMap(dup)).toThrow(/duplicate domain name/);
    fs.unlinkSync(dup);
  });
});

describe("routeSkills", () => {
  const skills = [
    qualified("design-mobile-apps"),
    qualified("design-taste-frontend"),
    qualified("webapp-testing"),
    qualified("caveman"),
    qualified("crafting-effective-readmes"),
  ];
  const map: DomainMap = {
    domains: [
      {
        name: "design",
        description: "UI/UX",
        triggers: ["design"],
        antiTriggers: [],
        skills: ["design-mobile-apps", "design-taste-frontend"],
      },
      { name: "test", skills: ["webapp-testing"] },
    ],
  };

  it("splits mapped skills into domains and leaves the rest global", () => {
    const routing = routeSkills(skills, map, "/tmp/map.json");
    expect(routing.enabled).toBe(true);
    expect(routing.domains.map((d) => d.name)).toEqual(["design", "test"]);
    expect(routing.domains[0].skills.map((s) => s.baseName)).toEqual([
      "design-mobile-apps",
      "design-taste-frontend",
    ]);
    expect(routing.domains[1].skills.map((s) => s.baseName)).toEqual(["webapp-testing"]);
    expect(routing.globalSkills.map((s) => s.baseName)).toEqual([
      "caveman",
      "crafting-effective-readmes",
    ]);
    expect(routing.warnings).toEqual([]);
  });

  it("matches skills by qualified name as well as base name", () => {
    const routing = routeSkills(skills, {
      domains: [{ name: "test", skills: ["local__webapp-testing"] }],
    }, null);
    expect(routing.domains[0].skills.map((s) => s.baseName)).toEqual(["webapp-testing"]);
    expect(routing.globalSkills).toHaveLength(4);
  });

  it("honours SKILL.md frontmatter domain/domains as a fallback", () => {
    const tagged = createTestSkill({
      name: "local__tagged",
      baseName: "tagged",
      source: createTestSource(),
      frontmatter: { name: "tagged", description: "x", domain: "design" },
    });
    const taggedList = createTestSkill({
      name: "local__tagged-list",
      baseName: "tagged-list",
      source: createTestSource(),
      frontmatter: { name: "tagged-list", description: "x", domains: ["test", "design"] },
    });
    const routing = routeSkills([tagged, taggedList, ...skills], map, null);
    expect(routing.domains[0].skills.map((s) => s.baseName)).toContain("tagged");
    expect(routing.domains[0].skills.map((s) => s.baseName)).toContain("tagged-list");
  });

  it("assigns a skill to the first matching domain only", () => {
    const routing = routeSkills(skills, {
      domains: [
        { name: "first", skills: ["caveman"] },
        { name: "second", skills: ["caveman"] },
      ],
    }, null);
    expect(routing.domains[0].skills.map((s) => s.baseName)).toEqual(["caveman"]);
    expect(routing.domains[1].skills).toHaveLength(0);
    expect(routing.warnings.some((w) => /already assigned/.test(w))).toBe(true);
  });

  it("warns about unknown skill names without failing", () => {
    const routing = routeSkills(skills, {
      domains: [{ name: "design", skills: ["no-such-skill", "design-mobile-apps"] }],
    }, null);
    expect(routing.warnings).toEqual([
      'domain "design": skill "no-such-skill" not found (ignored)',
    ]);
    expect(routing.domains[0].skills.map((s) => s.baseName)).toEqual(["design-mobile-apps"]);
  });

  it("emits every skill as global when the map has no domains", () => {
    const routing = routeSkills(skills, { domains: [] }, null);
    expect(routing.globalSkills).toHaveLength(skills.length);
    expect(routing.domains).toHaveLength(0);
  });
});

describe("renderDomainIndex", () => {
  it("renders a compact index with names, descriptions and counts but no skill names", () => {
    const routing = routeSkills(
      [qualified("a"), qualified("b")],
      {
        domains: [
          { name: "design", description: "UI & <UX>", triggers: ["design", "UI"], skills: ["a"] },
          { name: "test", skills: ["b"] },
        ],
      },
      null
    );
    const xml = renderDomainIndex(routing);
    expect(xml).toContain("<skill_domains>");
    expect(xml).toContain("<name>design</name>");
    expect(xml).toContain("&lt;UX&gt;");
    expect(xml).toContain("<skill_count>1</skill_count>");
    expect(xml).toContain("<triggers>design, UI</triggers>");
    expect(xml).not.toContain("<name>a</name>"); // skill entries are NOT in the index
    expect(xml).toContain("`find-skills-for-task`");
  });

  it("renders nothing when routing is disabled", () => {
    const routing = routeSkills([qualified("a")], { domains: [] }, null);
    expect(renderDomainIndex(routing)).toBe("");
  });
});

describe("buildDomainRouting", () => {
  const mapEnv = "SKILLJACK_DOMAIN_MAP";

  it("fails open to a flat catalog when routing is disabled", () => {
    const saved = process.env[mapEnv];
    const argv = process.argv;
    process.env[mapEnv] = "off";
    process.argv = ["node", "index.js"];
    try {
      const routing = buildDomainRouting([qualified("a")]);
      expect(routing.enabled).toBe(false);
      expect(routing.globalSkills).toHaveLength(1);
      expect(routing.domains).toHaveLength(0);
    } finally {
      process.argv = argv;
      if (saved === undefined) delete process.env[mapEnv];
      else process.env[mapEnv] = saved;
    }
  });

  it("fails open with a warning when the map file is invalid", () => {
    const saved = process.env[mapEnv];
    const argv = process.argv;
    const file = path.join(os.tmpdir(), `sj-bad-${process.pid}.json`);
    fs.writeFileSync(file, "{ broken", "utf-8");
    process.env[mapEnv] = file;
    process.argv = ["node", "index.js"];
    try {
      const routing = buildDomainRouting([qualified("a")]);
      expect(routing.enabled).toBe(false);
      expect(routing.globalSkills).toHaveLength(1);
      expect(routing.warnings[0]).toMatch(/domain routing disabled/);
    } finally {
      fs.unlinkSync(file);
      process.argv = argv;
      if (saved === undefined) delete process.env[mapEnv];
      else process.env[mapEnv] = saved;
    }
  });

  it("uses the configured map to route real skills", () => {
    const saved = process.env[mapEnv];
    const argv = process.argv;
    const file = path.join(os.tmpdir(), `sj-map-${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify({ domains: [{ name: "design", skills: ["a"] }] }), "utf-8");
    process.env[mapEnv] = file;
    process.argv = ["node", "index.js"];
    try {
      const routing = buildDomainRouting([qualified("a"), qualified("b")]);
      expect(routing.enabled).toBe(true);
      expect(routing.domains[0].skills.map((s) => s.baseName)).toEqual(["a"]);
      expect(routing.globalSkills.map((s) => s.baseName)).toEqual(["b"]);
    } finally {
      fs.unlinkSync(file);
      process.argv = argv;
      if (saved === undefined) delete process.env[mapEnv];
      else process.env[mapEnv] = saved;
    }
  });
});
