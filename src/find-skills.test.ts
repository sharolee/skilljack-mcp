import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { registerSkillTool } from "./skill-tool.js";
import { createTestSkill, createTestSkillState, createTestSource } from "./__test-helpers__/helpers.js";
import { SkillState } from "./skill-tool.js";

/**
 * Exercise the fork's `find-skills-for-task` tool over a real in-memory MCP
 * connection, with a real on-disk SKILL.md so `load-skill` proves that routing
 * is a discovery-layer concern only: a domain-gated skill stays fully loadable.
 *
 * Covers all three entry points (task, domain, no arguments) plus the
 * fail-open / precedence rules that keep older clients working unchanged.
 */
describe("find-skills-for-task tool", () => {
  let tmpRoot: string;
  let mapFile: string;
  let state: SkillState;
  let server: McpServer;
  let client: Client;
  const savedEnv = process.env.SKILLJACK_DOMAIN_MAP;
  const savedArgv = process.argv;

  function makeSkill(base: string, body: string) {
    const dir = path.join(tmpRoot, base);
    fs.mkdirSync(dir, { recursive: true });
    const skillMd = path.join(dir, "SKILL.md");
    fs.writeFileSync(
      skillMd,
      `---\nname: ${base}\ndescription: ${base} description\n---\n\n${body}\n`,
      "utf-8"
    );
    return createTestSkill({
      name: `local__${base}`,
      baseName: base,
      description: `${base} description`,
      path: skillMd,
      source: createTestSource(),
      frontmatter: { name: base, description: `${base} description` },
    });
  }

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sj-find-skills-"));
    const designA = makeSkill("design-mobile-apps", "# Mobile design body");
    const designB = makeSkill("design-taste-frontend", "# Tasty frontend body");
    const testSkill = makeSkill("webapp-testing", "# Webapp testing body");
    const globalA = makeSkill("caveman", "# Caveman body");
    const globalB = makeSkill("crafting-effective-readmes", "# README body");

    mapFile = path.join(tmpRoot, "domains.json");
    fs.writeFileSync(
      mapFile,
      JSON.stringify({
        version: 1,
        domains: [
          {
            name: "design",
            description: "UI/UX design",
            triggers: ["设计", "页面", "UI"],
            antiTriggers: ["单元测试"],
            skills: ["design-mobile-apps", "design-taste-frontend"],
          },
          {
            name: "test",
            description: "Webapp testing",
            triggers: ["测试", "Playwright", "E2E"],
            skills: ["webapp-testing"],
          },
        ],
      }),
      "utf-8"
    );
    process.env.SKILLJACK_DOMAIN_MAP = mapFile;
    process.argv = ["node", "index.js"];

    state = createTestSkillState([designA, designB, testSkill, globalA, globalB]);
    server = new McpServer({ name: "test", version: "0.0.1" });
    registerSkillTool(server, state, "instructions");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    process.argv = savedArgv;
    if (savedEnv === undefined) delete process.env.SKILLJACK_DOMAIN_MAP;
    else process.env.SKILLJACK_DOMAIN_MAP = savedEnv;
  });

  function textOf(res: { content: unknown }): string {
    return (res.content as Array<{ type: string; text: string }>).find((c) => c.type === "text")!.text;
  }

  it("registers find-skills-for-task alongside load-skill and skill-resource", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("find-skills-for-task");
    expect(names).toContain("load-skill");
    expect(names).toContain("skill-resource");
    expect(names).not.toContain("route-domain");
  });

  it("exposes the domain directory in the tool description", async () => {
    const tool = (await client.listTools()).tools.find((t) => t.name === "find-skills-for-task");
    expect(tool?.description).toContain("<skill_domains>");
    expect(tool?.description).toContain("- design: UI/UX design");
    expect(tool?.description).toContain("- test: Webapp testing");
    // Trigger words stay server-side; only names + one-line descriptions are advertised.
    expect(tool?.description).not.toContain("<triggers>");
    expect(tool?.description).toContain("Call with `task`");
  });

  it("lists domains with no arguments (backward-compatible path)", async () => {
    const text = textOf(await client.callTool({ name: "find-skills-for-task", arguments: {} }));
    expect(text).toContain("<domains>");
    expect(text).toContain("<name>design</name>");
    expect(text).toContain("<skill_count>2</skill_count>");
    expect(text).toContain("<name>test</name>");
    expect(text).not.toContain("<name>design-mobile-apps</name>");
  });

  it("expands a named domain into catalog skill entries", async () => {
    const text = textOf(
      await client.callTool({ name: "find-skills-for-task", arguments: { domain: "design" } })
    );
    expect(text).toContain("<available_skills>");
    expect(text).toContain("<name>local__design-mobile-apps</name>");
    expect(text).toContain("<name>local__design-taste-frontend</name>");
    expect(text).toContain("<uri>skill://test/design-mobile-apps/SKILL.md</uri>");
    expect(text).not.toContain("<name>local__caveman</name>");
    expect(text).not.toContain("<name>local__webapp-testing</name>");
  });

  it("is case-insensitive on domain names", async () => {
    const text = textOf(
      await client.callTool({ name: "find-skills-for-task", arguments: { domain: "TEST" } })
    );
    expect(text).toContain("<name>local__webapp-testing</name>");
  });

  it("returns an error with available domains for an unknown domain", async () => {
    const res = await client.callTool({
      name: "find-skills-for-task",
      arguments: { domain: "nope" },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('Unknown domain "nope"');
    expect(textOf(res)).toContain("design, test");
  });

  it("scores a task and returns the best domain's skill entries in one call", async () => {
    const text = textOf(
      await client.callTool({
        name: "find-skills-for-task",
        arguments: { task: "帮我设计一个页面" },
      })
    );
    expect(text).toContain("<task_routing>");
    expect(text).toContain("<best_match>design</best_match>");
    expect(text).toContain("<matched_triggers>");
    expect(text).toContain("<available_skills>");
    expect(text).toContain("<name>local__design-mobile-apps</name>");
    expect(text).toContain("`load-skill`");
    expect(text).not.toContain("<name>local__webapp-testing</name>");
  });

  it("logs the task -> domain decision to stderr for trigger maintenance", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await client.callTool({
        name: "find-skills-for-task",
        arguments: { task: "用 Playwright 补一个 E2E 用例" },
      });
      expect(spy.mock.calls.flat().join(" ")).toContain("Task skill routing:");
      expect(spy.mock.calls.flat().join(" ")).toContain("test(");
    } finally {
      spy.mockRestore();
    }
  });

  it("fails open to the domain directory when no domain matches a task", async () => {
    const text = textOf(
      await client.callTool({
        name: "find-skills-for-task",
        arguments: { task: "今天天气怎么样" },
      })
    );
    expect(text).toContain("No domain matched this task");
    expect(text).toContain("<domains>");
    expect(text).not.toContain("<task_routing>");
  });

  it("lets an explicit domain override a task string", async () => {
    const text = textOf(
      await client.callTool({
        name: "find-skills-for-task",
        arguments: { task: "帮我设计一个页面", domain: "test" },
      })
    );
    expect(text).toContain("<name>local__webapp-testing</name>");
    expect(text).not.toContain("<task_routing>");
  });

  it("treats an empty task as the no-argument path", async () => {
    const text = textOf(
      await client.callTool({ name: "find-skills-for-task", arguments: { task: "   " } })
    );
    expect(text).toContain("<domains>");
    expect(text).not.toContain("<task_routing>");
  });

  it("vetoes a domain whose antiTrigger matches the task", async () => {
    const text = textOf(
      await client.callTool({
        name: "find-skills-for-task",
        arguments: { task: "写单元测试，不要做界面设计" },
      })
    );
    expect(text).toContain("<best_match>test</best_match>");
    expect(text).not.toContain("<name>local__design-mobile-apps</name>");
  });

  it("still loads a domain-gated skill by name via load-skill", async () => {
    const res = await client.callTool({
      name: "load-skill",
      arguments: { name: "local__design-mobile-apps" },
    });
    expect(res.isError).not.toBe(true);
    expect(textOf(res)).toContain("# Mobile design body");
  });

  it("keeps global skills loadable too", async () => {
    const res = await client.callTool({
      name: "load-skill",
      arguments: { name: "local__caveman" },
    });
    expect(res.isError).not.toBe(true);
    expect(textOf(res)).toContain("# Caveman body");
  });
});
