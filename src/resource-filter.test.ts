/**
 * Tests for the fork's listing-only resource filter.
 *
 * These set SKILLJACK_RESOURCE_FILTER explicitly: the shared vitest config
 * pins it to "off" so the upstream suite keeps exercising unfiltered listings.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getResourceFilter, describeResourceFilter } from "./resource-filter.js";
import { listSkillFiles, isListedSkillFile, isListedSkillDir } from "./skill-tool.js";

const ENV_KEY = "SKILLJACK_RESOURCE_FILTER";
const DIRS_KEY = "SKILLJACK_EXCLUDE_DIRS";
const EXTS_KEY = "SKILLJACK_EXCLUDE_EXTENSIONS";
const KEYS = [ENV_KEY, DIRS_KEY, EXTS_KEY] as const;

let root: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of KEYS) saved[key] = process.env[key];
  process.env[ENV_KEY] = "on";
  for (const key of [DIRS_KEY, EXTS_KEY]) delete process.env[key];
  root = fs.mkdtempSync(path.join(os.tmpdir(), "skilljack-filter-"));
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function makeSkill(files: Record<string, string | Buffer>): string {
  const skillDir = path.join(root, "kit");
  fs.mkdirSync(skillDir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(skillDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return skillDir;
}

const KIT = {
  "SKILL.md": "---\nname: kit\ndescription: d\n---\nbody\n",
  "references/guide.md": "guide",
  "scripts/build.mjs": "console.log(1)",
  "assets/hero.svg": "<svg/>",
  "assets/photo.webp": Buffer.from([0x52, 0x49, 0x46, 0x46]),
  "assets/nested/fragment.html": "<div/>",
  "data/stacks.csv": "a,b\n1,2\n",
};

describe("resource filter — automatic listings", () => {
  it("drops the assets/ tree and binary extensions but keeps instructions", () => {
    const skillDir = makeSkill(KIT);
    const files = listSkillFiles(skillDir);

    expect(files).toContain("references/guide.md");
    expect(files).toContain("scripts/build.mjs");
    expect(files).toContain("data/stacks.csv");
    expect(files).not.toContain("assets/hero.svg");
    expect(files).not.toContain("assets/photo.webp");
    expect(files).not.toContain("assets/nested/fragment.html");
    expect(files).not.toContain("SKILL.md");
  });

  it("filters case-insensitively on extensions", () => {
    const skillDir = makeSkill({ ...KIT, "images/LOGO.PNG": Buffer.from([0x89, 0x50]) });
    expect(listSkillFiles(skillDir)).not.toContain("images/LOGO.PNG");
  });

  it("is a no-op when disabled, restoring upstream behaviour", () => {
    const skillDir = makeSkill(KIT);
    process.env[ENV_KEY] = "off";
    const files = listSkillFiles(skillDir);
    expect(files).toContain("assets/hero.svg");
    expect(files).toContain("assets/photo.webp");
    expect(files).toContain("assets/nested/fragment.html");
  });

  it("supports custom dir and extension overrides", () => {
    const skillDir = makeSkill(KIT);
    process.env[DIRS_KEY] = "data";
    process.env[EXTS_KEY] = ".md,.csv";
    const files = listSkillFiles(skillDir);

    expect(files).toContain("assets/hero.svg"); // assets no longer excluded
    expect(files).not.toContain("data/stacks.csv"); // custom dir excluded
    expect(files).not.toContain("references/guide.md"); // custom ext excluded
    expect(files).toContain("scripts/build.mjs");
  });

  it("treats an empty override as disabling that dimension", () => {
    const skillDir = makeSkill(KIT);
    process.env[DIRS_KEY] = "";
    process.env[EXTS_KEY] = "";
    const files = listSkillFiles(skillDir);
    expect(files).toContain("assets/hero.svg");
    expect(files).toContain("assets/photo.webp");
  });
});

describe("resource filter — explicit reads stay available", () => {
  it("keeps read-time guards unfiltered for assets omitted from listings", () => {
    const skillDir = makeSkill(KIT);
    // Everything assets/ contains is hidden from listSkillFiles ...
    expect(listSkillFiles(skillDir).some((f) => f.startsWith("assets/"))).toBe(false);
    // ... but the read-time guards still allow on-demand access.
    expect(isListedSkillFile(skillDir, "assets/hero.svg")).toBe(true);
    expect(isListedSkillFile(skillDir, "assets/photo.webp")).toBe(true);
    expect(isListedSkillDir(skillDir, "assets")).toBe(true);
    expect(isListedSkillDir(skillDir, "assets/nested")).toBe(true);
  });

  it("still refuses hidden files, node_modules and SKILL.md", () => {
    const skillDir = makeSkill(KIT);
    fs.mkdirSync(path.join(skillDir, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(skillDir, "node_modules", "pkg", "x.js"), "x");
    fs.writeFileSync(path.join(skillDir, ".env"), "TOKEN=x");
    expect(isListedSkillFile(skillDir, "SKILL.md")).toBe(false);
    expect(isListedSkillFile(skillDir, ".env")).toBe(false);
    expect(isListedSkillFile(skillDir, "node_modules/pkg/x.js")).toBe(false);
    expect(isListedSkillDir(skillDir, "node_modules")).toBe(false);
  });
});

describe("resource filter — config resolution", () => {
  it("defaults to enabled with assets + binary extensions", () => {
    delete process.env[ENV_KEY];
    const cfg = getResourceFilter();
    expect(cfg.enabled).toBe(true);
    expect(cfg.dirs.has("assets")).toBe(true);
    expect(cfg.extensions.has(".svg")).toBe(true);
    expect(cfg.extensions.has(".png")).toBe(true);
    expect(cfg.extensions.has(".md")).toBe(false);
  });

  it("parses off/false/0 and empty as disabled", () => {
    for (const value of ["off", "OFF", "false", "0", "no", ""]) {
      process.env[ENV_KEY] = value;
      expect(getResourceFilter().enabled, value).toBe(false);
    }
  });

  it("normalizes extensions with or without a leading dot", () => {
    process.env[EXTS_KEY] = "PNG, .webp,,JPG";
    const cfg = getResourceFilter();
    expect([...cfg.extensions].sort()).toEqual([".jpg", ".png", ".webp"]);
  });

  it("produces an observable startup description", () => {
    expect(describeResourceFilter()).toContain("resource filter: ON");
    process.env[ENV_KEY] = "off";
    expect(describeResourceFilter()).toContain("OFF");
  });
});
