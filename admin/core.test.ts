import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  scanSkills,
  frontmatterDomains,
  skillKeys,
  readDomainMap,
  validateDomainMap,
  writeDomainMap,
  computeState,
  type DomainMap,
} from "./core.js";

let root: string;

function validFm(name: string, extra = ""): string {
  return `name: ${name}\ndescription: 描述 ${name}${extra ? `\n${extra}` : ""}`;
}

function writeSkill(dirName: string, frontmatter: string, body = "# Body\n"): void {
  const dir = path.join(root, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}`, "utf-8");
}

function writeMap(map: unknown, fileName = "domains.json"): string {
  const file = path.join(root, fileName);
  fs.writeFileSync(file, `${JSON.stringify(map, null, 2)}\n`, "utf-8");
  return file;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sj-admin-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Skill discovery
// ---------------------------------------------------------------------------

describe("scanSkills", () => {
  it("reads frontmatter, content and resource summary for a valid skill", () => {
    writeSkill("alpha", validFm("alpha-tool", "domain: design\nuser-invocable: false"));
    for (const [dir, file] of [["references", "a.md"], ["scripts", "run.py"], ["assets", "logo.png"]] as const) {
      const d = path.join(root, "alpha", dir);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, file), "x");
    }

    const skills = scanSkills(root);
    expect(skills).toHaveLength(1);
    const s = skills[0];
    expect(s.name).toBe("alpha-tool");
    expect(s.dirName).toBe("alpha");
    expect(s.valid).toBe(true);
    expect(s.modelInvocable).toBe(true);
    expect(s.frontmatter["domain"]).toBe("design");
    expect(s.frontmatter["user-invocable"]).toBe(false);
    expect(s.fileCount).toBe(4); // SKILL.md + 3 supporting files
    expect(s.topDirs).toEqual(["assets", "references", "scripts"]);
    expect(s.content).toContain("# Body");
    expect(frontmatterDomains(s)).toEqual(["design"]);
    expect(skillKeys(s, "skills")).toContain("skills__alpha-tool");
  });

  it("flags broken skills instead of dropping them, and skips hidden dirs", () => {
    writeSkill("good", validFm("good"));
    fs.mkdirSync(path.join(root, "empty"), { recursive: true });
    writeSkill("nofields", "foo: bar");
    fs.mkdirSync(path.join(root, "plain"), { recursive: true });
    fs.writeFileSync(path.join(root, "plain", "SKILL.md"), "no frontmatter here");
    fs.mkdirSync(path.join(root, ".hidden"), { recursive: true });

    const skills = scanSkills(root);
    const byDir = Object.fromEntries(skills.map((s) => [s.dirName, s]));
    expect(byDir.good.valid).toBe(true);
    expect(byDir.empty.valid).toBe(false);
    expect(byDir.empty.issue).toContain("缺少");
    expect(byDir.nofields.issue).toContain("name 或 description");
    expect(byDir.plain.issue).toContain("frontmatter");
    expect(byDir[".hidden"]).toBeUndefined();
  });

  it("flags symlinks / junctions as skipped (the server does the same)", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "sj-link-target-"));
    try {
      fs.writeFileSync(path.join(outside, "SKILL.md"), `---\n${validFm("linked")}\n---\n`);
      const link = path.join(root, "linked");
      try {
        fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
      } catch {
        return; // creating links can be restricted; skip the assertion
      }
      const s = scanSkills(root).find((x) => x.dirName === "linked");
      expect(s?.isLink).toBe(true);
      expect(s?.valid).toBe(false);
      expect(s?.issue).toContain("跳过");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("returns an empty list for a missing directory", () => {
    expect(scanSkills(path.join(root, "nope"))).toEqual([]);
    expect(scanSkills("")).toEqual([]);
  });

  it("honours disable-model-invocation", () => {
    writeSkill("quiet", validFm("quiet", "disable-model-invocation: true"));
    expect(scanSkills(root)[0].modelInvocable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Domain map reading / validation
// ---------------------------------------------------------------------------

describe("readDomainMap", () => {
  it("parses and normalizes a valid map", () => {
    const file = writeMap({
      version: 1,
      domains: [{ name: " design ", description: " x ", triggers: ["UI", 7], skills: ["a", ""] }],
    });
    expect(readDomainMap(file)).toEqual({
      version: 1,
      domains: [{ name: "design", description: "x", triggers: ["UI"], antiTriggers: [], skills: ["a"] }],
    });
  });

  it("rejects malformed JSON, missing domains array and duplicate names", () => {
    const bad = path.join(root, "bad.json");
    fs.writeFileSync(bad, "{ not json");
    expect(() => readDomainMap(bad)).toThrow(/合法 JSON/);
    expect(() => readDomainMap(writeMap({ domains: {} }))).toThrow(/domains 数组/);
    expect(() => readDomainMap(writeMap({ domains: [{ name: "a", skills: [] }, { name: "A", skills: [] }] })))
      .toThrow(/重复/);
    expect(() => readDomainMap(writeMap({ domains: [{ skills: [] }] }))).toThrow(/name/);
  });
});

describe("validateDomainMap", () => {
  const makeContext = (): { skills: ReturnType<typeof scanSkills>; prefix: string } => {
    writeSkill("alpha", validFm("alpha-tool"));
    return { skills: scanSkills(root), prefix: path.basename(root) };
  };

  it("normalizes names, de-duplicates and accepts qualified names", () => {
    const { skills, prefix } = makeContext();
    const result = validateDomainMap(
      { version: 1, domains: [{ name: " design ", description: " x ", skills: [" alpha-tool ", "alpha-tool", `${prefix}__ALPHA-TOOL`] }] },
      skills,
      prefix
    );
    expect(result.errors).toEqual([]);
    expect(result.map.domains[0].name).toBe("design");
    expect(result.map.domains[0].description).toBe("x");
    expect(result.map.domains[0].skills).toEqual(["alpha-tool"]);
  });

  it("warns (but does not block) on skills not installed on this machine", () => {
    const { skills, prefix } = makeContext();
    const result = validateDomainMap({ domains: [{ name: "design", skills: ["ghost-tool"] }] }, skills, prefix);
    expect(result.errors).toEqual([]);
    expect(result.warnings.join(" ")).toContain("ghost-tool");
  });

  it("blocks duplicate domains, empty names, non-array skills and multi-domain membership", () => {
    const { skills, prefix } = makeContext();
    expect(validateDomainMap({ domains: [{ name: "", skills: [] }] }, skills, prefix).errors.join(" ")).toContain("name");
    expect(validateDomainMap({ domains: [{ name: "a", skills: [] }, { name: "A", skills: [] }] }, skills, prefix).errors.join(" ")).toContain("重复");
    expect(validateDomainMap({ domains: [{ name: "a", skills: "x" }] }, skills, prefix).errors.join(" ")).toContain("数组");
    const conflict = validateDomainMap(
      { domains: [{ name: "a", skills: ["alpha-tool"] }, { name: "b", skills: ["alpha-tool"] }] },
      skills,
      prefix
    );
    expect(conflict.errors.join(" ")).toContain("只能属于一个领域");
  });

  it("rejects a non-object payload", () => {
    expect(validateDomainMap(null, [], "").errors.length).toBeGreaterThan(0);
    expect(validateDomainMap({ domains: [] }, [], "").errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

describe("writeDomainMap", () => {
  const map: DomainMap = { version: 1, domains: [{ name: "design", skills: ["alpha-tool"] }] };

  it("creates the file on first write, with no backup", () => {
    const file = path.join(root, "nested", "domains.json");
    const result = writeDomainMap(file, map);
    expect(result.backupPath).toBeNull();
    expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual(map);
    expect(fs.existsSync(`${file}.tmp-${process.pid}`)).toBe(false);
  });

  it("backs up the previous content before overwriting", () => {
    const file = writeMap({ version: 1, domains: [] });
    const before = fs.readFileSync(file, "utf-8");
    const result = writeDomainMap(file, map);
    expect(result.backupPath).toBeTruthy();
    expect(fs.readFileSync(result.backupPath as string, "utf-8")).toBe(before);
    expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual(map);
  });

  it("never overwrites a backup on rapid successive saves and keeps only 5", () => {
    const file = writeMap({ version: 1, domains: [] });
    const backups = new Set<string>();
    for (let i = 0; i < 7; i++) {
      const result = writeDomainMap(file, { version: 1, domains: [{ name: `d${i}`, skills: [] }] });
      if (result.backupPath) backups.add(result.backupPath);
    }
    expect(backups.size).toBe(7); // the initial file exists, so every write backs up
    const remaining = fs.readdirSync(root).filter((f) => f.startsWith("domains.json.bak-"));
    expect(remaining.length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// State assembly / routing parity
// ---------------------------------------------------------------------------

describe("computeState", () => {
  it("mirrors the server: map wins, frontmatter is a fallback, untagged is global", () => {
    writeSkill("alpha", validFm("alpha-tool", "domain: design"));
    writeSkill("beta", validFm("beta-tool"));
    writeSkill("gamma", validFm("gamma-tool"));
    const mapPath = writeMap({
      version: 1,
      domains: [
        { name: "design", description: "界面设计", triggers: ["UI"], skills: ["beta-tool"] },
        { name: "test", skills: [] },
      ],
    });

    const state = computeState({ skillsDir: root, mapPath });
    const byName = Object.fromEntries(state.skills.map((s) => [s.name, s]));
    expect(byName["alpha-tool"].domain).toBe("design");
    expect(byName["alpha-tool"].domainSource).toBe("frontmatter");
    expect(byName["beta-tool"].domain).toBe("design");
    expect(byName["beta-tool"].domainSource).toBe("map");
    expect(byName["gamma-tool"].domain).toBeNull();

    expect(state.stats.global).toBe(1);
    expect(state.stats.byDomain.design).toBe(2);
    expect(state.stats.byDomain.test).toBe(0);
    expect(state.stats.eligible).toBe(3);
    expect(state.stats.routedCatalogBytes).toBeLessThan(state.stats.flatCatalogBytes);
    expect(state.stats.savedPercent).toBeGreaterThan(0);
    expect(state.warnings).toEqual([]);
  });

  it("fails open with warnings when the map is missing or the skills dir is unset", () => {
    const missing = computeState({ skillsDir: root, mapPath: path.join(root, "absent.json") });
    expect(missing.domains).toEqual([]);
    expect(missing.warnings.join(" ")).toContain("空映射启动");

    const unset = computeState({ skillsDir: "", mapPath: "" });
    expect(unset.skills).toEqual([]);
    expect(unset.warnings.join(" ")).toContain("尚未配置技能库");
  });

  it("excludes disable-model-invocation skills from catalog accounting", () => {
    writeSkill("quiet", validFm("quiet", "disable-model-invocation: true"));
    const state = computeState({ skillsDir: root, mapPath: path.join(root, "absent.json") });
    expect(state.stats.eligible).toBe(0);
    expect(state.stats.global).toBe(0);
    expect(state.skills[0].domain).toBeNull();
  });
});
