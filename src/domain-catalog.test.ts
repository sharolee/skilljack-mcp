import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getCatalogInstructions, getServerInstructions } from "./skill-tool.js";
import { createTestSkill, createTestSkillState, createTestSource } from "./__test-helpers__/helpers.js";

const skills = () => [
  createTestSkill({ name: "local__design-mobile-apps", baseName: "design-mobile-apps", description: "Design mobile apps", source: createTestSource() }),
  createTestSkill({ name: "local__webapp-testing", baseName: "webapp-testing", description: "Test webapps", source: createTestSource() }),
  createTestSkill({ name: "local__caveman", baseName: "caveman", description: "Terse voice", source: createTestSource() }),
  createTestSkill({ name: "local__crafting-effective-readmes", baseName: "crafting-effective-readmes", description: "Write READMEs", source: createTestSource() }),
];

describe("domain-routed catalog (instructions mode)", () => {
  const mapEnv = "SKILLJACK_DOMAIN_MAP";
  let mapFile: string;
  const savedEnv = process.env[mapEnv];
  const savedArgv = process.argv;

  beforeEach(() => {
    mapFile = path.join(os.tmpdir(), `sj-catalog-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(
      mapFile,
      JSON.stringify({
        domains: [
          { name: "design", description: "UI/UX", skills: ["design-mobile-apps"] },
          { name: "test", skills: ["webapp-testing"] },
        ],
      }),
      "utf-8"
    );
    process.env[mapEnv] = mapFile;
    process.argv = ["node", "index.js"];
  });

  afterEach(() => {
    fs.rmSync(mapFile, { force: true });
    process.argv = savedArgv;
    if (savedEnv === undefined) delete process.env[mapEnv];
    else process.env[mapEnv] = savedEnv;
  });

  it("lists only global skills in <available_skills> plus a compact domain index", () => {
    const instructions = getCatalogInstructions(createTestSkillState(skills()), "auto");
    // domain index is present and compact
    expect(instructions).toContain("<skill_domains>");
    expect(instructions).toContain("<name>design</name>");
    expect(instructions).toContain("<name>test</name>");
    expect(instructions).toContain("<skill_count>1</skill_count>");
    // global skills listed
    expect(instructions).toContain("<name>local__caveman</name>");
    expect(instructions).toContain("<name>local__crafting-effective-readmes</name>");
    // domain-gated skills NOT in the flat catalog
    expect(instructions).not.toContain("<name>local__design-mobile-apps</name>");
    expect(instructions).not.toContain("<name>local__webapp-testing</name>");
    // and the index never embeds their skill entries
    const indexPart = instructions.slice(instructions.indexOf("<skill_domains>"));
    expect(indexPart).not.toContain("<description>Design mobile apps</description>");
  });

  it("keeps <available_skills> well-formed with global skills", () => {
    const instructions = getServerInstructions(createTestSkillState(skills()), "instructions")!;
    expect(instructions).toContain("<available_skills>");
    expect(instructions).toContain("</available_skills>");
    expect(instructions.indexOf("<available_skills>")).toBeLessThan(instructions.indexOf("<skill_domains>"));
  });

  it("fails back to the flat catalog when routing is disabled", () => {
    process.env[mapEnv] = "off";
    const instructions = getCatalogInstructions(createTestSkillState(skills()), "auto");
    expect(instructions).not.toContain("<skill_domains>");
    expect(instructions).toContain("<name>local__design-mobile-apps</name>");
    expect(instructions).toContain("<name>local__webapp-testing</name>");
    expect(instructions).toContain("<name>local__caveman</name>");
  });

  it("puts the discovery preflight ahead of the catalog when routing is active", () => {
    const instructions = getCatalogInstructions(createTestSkillState(skills()), "auto");
    expect(instructions.startsWith("<skill_preflight>")).toBe(true);
    expect(instructions).toContain("`find-skills-for-task`");
    expect(instructions).toContain("`task`");
    const preflightEnd = instructions.indexOf("</skill_preflight>");
    const catalogStart = instructions.indexOf("<available_skills>", preflightEnd);
    expect(preflightEnd).toBeLessThan(catalogStart);
    expect(catalogStart).toBeLessThan(instructions.indexOf("<skill_domains>"));
  });

  it("omits the preflight entirely when routing is disabled", () => {
    process.env[mapEnv] = "off";
    const instructions = getCatalogInstructions(createTestSkillState(skills()), "auto");
    expect(instructions).not.toContain("<skill_preflight>");
    expect(instructions).not.toContain("find-skills-for-task");
  });

  it("keeps the preflight under 700 bytes so catalog savings survive", () => {
    const instructions = getCatalogInstructions(createTestSkillState(skills()), "auto");
    const end = instructions.indexOf("</skill_preflight>") + "</skill_preflight>".length;
    expect(end).toBeGreaterThan(0);
    expect(Buffer.byteLength(instructions.slice(0, end))).toBeLessThan(700);
  });
});
