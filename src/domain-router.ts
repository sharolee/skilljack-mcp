/**
 * Domain routing for the skill catalog (fork addition).
 *
 * A flat <available_skills> catalog lists every skill in the server
 * `instructions` on every connection. At 100+ skills that catalog alone costs
 * ~15k tokens before any work begins, and the cost grows linearly with the
 * library. This module adds an OPTIONAL second discovery layer: skills can be
 * tagged with a domain, and only untagged ("global") skills plus a compact
 * domain index are put in the main catalog. The model calls
 * `find-skills-for-task` to expand one domain into its skill entries, either
 * by naming it or by submitting a task description for server-side scoring.
 *
 * Design invariants:
 *  - Routing ONLY reshapes the catalog delivered to the model. It never
 *    removes a skill from `skillMap`, so `load-skill`, `skill-resource`,
 *    `resources/list`, `skills/list` / `skills/get` (SEP-2640) and prompts all
 *    keep every skill addressable. A model that already knows a name can load
 *    it directly; a host that uses the skills extension sees the full list.
 *  - Skills with NO domain are "global" and are listed in the main catalog
 *    exactly as upstream. Domains are opt-in; routing is backward compatible.
 *  - Domains are declared in a JSON map (CLI `--domain-map` / env
 *    `SKILLJACK_DOMAIN_MAP`), with SKILL.md frontmatter `domain` / `domains`
 *    as a portable fallback for skills that travel between repositories.
 *
 * Configuration format (UTF-8 JSON):
 *   {
 *     "version": 1,
 *     "domains": [
 *       {
 *         "name": "design",
 *         "description": "UI/UX, visual design, design systems",
 *         "triggers": ["design", "UI", "frontend"],
 *         "antiTriggers": ["backend logic"],
 *         "skills": ["design-mobile-apps", "design-taste-frontend"]
 *       }
 *     ]
 *   }
 * Skill names in `skills[]` may be either the frontmatter (base) name or the
 * qualified `prefix__name`. Unknown names are ignored with a startup warning
 * so a stale map never hides or breaks a real skill.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { SkillMetadata } from "./skill-discovery.js";

/** A single domain declaration from the map. */
export interface DomainDefinition {
  name: string;
  description?: string;
  triggers?: string[];
  antiTriggers?: string[];
  skills: string[];
}

/** Parsed top-level domain map. */
export interface DomainMap {
  version?: number;
  domains: DomainDefinition[];
}

/** A domain with its resolved, discovered skills. */
export interface RoutedDomain {
  name: string;
  description: string;
  triggers: string[];
  antiTriggers: string[];
  skills: SkillMetadata[];
}

/**
 * Result of splitting the discovered skills for catalog routing.
 * `global` skills are listed in the main catalog; `domains` are expandable on
 * demand via `find-skills-for-task`. `warnings` are surfaced on stderr at startup.
 */
export interface DomainRouting {
  enabled: boolean;
  globalSkills: SkillMetadata[];
  domains: RoutedDomain[];
  warnings: string[];
  mapPath: string | null;
}

/**
 * Resolve the active domain-map path. Priority: `--domain-map=<path>` (single
 * token so parseCLIArgs does not treat it as a skill dir) > SKILLJACK_DOMAIN_MAP
 * > `domains.json` in the current working directory. Returns null when no map
 * is configured and no default file exists — routing then degrades to the flat
 * upstream catalog.
 */
export function getDomainMapPath(): string | null {
  const flag = "--domain-map=";
  const arg = process.argv.slice(2).find((a) => a.startsWith(flag));
  const raw = arg !== undefined ? arg.slice(flag.length) : process.env.SKILLJACK_DOMAIN_MAP;
  // An explicit "off" disables routing (flat upstream catalog). Useful as a
  // rollback knob and to keep upstream tests independent of a domains.json
  // that happens to sit in the repo root.
  if (raw !== undefined && ["off", "0", "false", "none"].includes(raw.trim().toLowerCase())) {
    return null;
  }
  if (raw !== undefined && raw.trim() !== "") return path.resolve(raw.trim());
  const fallback = path.resolve(process.cwd(), "domains.json");
  return fs.existsSync(fallback) ? fallback : null;
}

/**
 * Parse a domain map from a file. Malformed JSON or a missing `domains` array
 * throws a descriptive Error so the caller can warn and fall back to the flat
 * catalog rather than crashing the server.
 */
export function readDomainMap(mapPath: string): DomainMap {
  const text = fs.readFileSync(mapPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid JSON in ${mapPath}: ${message}`);
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as DomainMap).domains)) {
    throw new Error(`${mapPath}: expected an object with a "domains" array`);
  }
  const domains: DomainDefinition[] = [];
  const seenNames = new Set<string>();
  for (const [i, raw] of ((parsed as DomainMap).domains as unknown[]).entries()) {
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`${mapPath}: domains[${i}] is not an object`);
    }
    const def = raw as Partial<DomainDefinition>;
    if (typeof def.name !== "string" || def.name.trim() === "") {
      throw new Error(`${mapPath}: domains[${i}] is missing a non-empty "name"`);
    }
    const name = def.name.trim();
    if (seenNames.has(name.toLowerCase())) {
      throw new Error(`${mapPath}: duplicate domain name "${name}"`);
    }
    seenNames.add(name.toLowerCase());
    domains.push({
      name,
      description: typeof def.description === "string" ? def.description.trim() : "",
      triggers: toStringArray(def.triggers),
      antiTriggers: toStringArray(def.antiTriggers),
      skills: toStringArray(def.skills),
    });
  }
  return { version: (parsed as DomainMap).version, domains };
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
}

/** Frontmatter keys that can tag a skill with one or more domains. */
function frontmatterDomains(skill: SkillMetadata): string[] {
  const fm = skill.frontmatter;
  const raw = fm["domain"] ?? fm["domains"];
  if (typeof raw === "string") return toStringArray([raw]);
  if (Array.isArray(raw)) return toStringArray(raw);
  return [];
}

/**
 * Build the routing plan for a set of discovered skills.
 *
 * A skill belongs to a domain if either (a) the map lists its base or
 * qualified name, or (b) its SKILL.md frontmatter carries a `domain`/`domains`
 * value that matches a declared domain name. Untagged skills are global.
 * A skill listed in more than one domain is assigned to the FIRST matching
 * domain to keep the catalog unambiguous.
 */
export function routeSkills(skills: SkillMetadata[], map: DomainMap, mapPath: string | null): DomainRouting {
  const warnings: string[] = [];
  const claimed = new Set<string>(); // qualified skill name -> already assigned
  const byName = new Map<string, SkillMetadata>();
  for (const skill of skills) {
    byName.set(skill.name.toLowerCase(), skill);
    byName.set(skill.baseName.toLowerCase(), skill);
  }

  const routedDomains: RoutedDomain[] = [];
  for (const def of map.domains) {
    const members: SkillMetadata[] = [];
    const wanted = new Set(def.skills.map((s) => s.toLowerCase()));

    for (const rawName of def.skills) {
      const skill = byName.get(rawName.toLowerCase());
      if (!skill) {
        warnings.push(`domain "${def.name}": skill "${rawName}" not found (ignored)`);
        continue;
      }
      if (claimed.has(skill.name)) {
        warnings.push(
          `domain "${def.name}": skill "${rawName}" already assigned to another domain (ignored)`
        );
        continue;
      }
      claimed.add(skill.name);
      members.push(skill);
    }

    // Frontmatter fallback: a skill that declares this domain by name but is
    // not in the map's skills[] still joins it (portable across repos).
    for (const skill of skills) {
      if (claimed.has(skill.name)) continue;
      const tags = frontmatterDomains(skill).map((d) => d.toLowerCase());
      if (tags.includes(def.name.toLowerCase())) {
        claimed.add(skill.name);
        members.push(skill);
      }
    }

    routedDomains.push({
      name: def.name,
      description: def.description ?? "",
      triggers: def.triggers ?? [],
      antiTriggers: def.antiTriggers ?? [],
      skills: members,
    });
  }

  const globalSkills = skills.filter((s) => !claimed.has(s.name));
  return { enabled: true, globalSkills, domains: routedDomains, warnings, mapPath };
}

/**
 * Resolve routing from CLI/env/default map for a set of skills. On a missing or
 * invalid map, returns a disabled routing plan with EVERY skill global — the
 * exact upstream catalog — so routing is fail-open, never fail-closed.
 */
export function buildDomainRouting(skills: SkillMetadata[]): DomainRouting {
  const mapPath = getDomainMapPath();
  if (mapPath === null) {
    return { enabled: false, globalSkills: skills, domains: [], warnings: [], mapPath: null };
  }
  try {
    const map = readDomainMap(mapPath);
    return routeSkills(skills, map, mapPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      enabled: false,
      globalSkills: skills,
      domains: [],
      warnings: [`domain routing disabled (${message}); listing all skills globally`],
      mapPath,
    };
  }
}

/** Escape special XML characters (mirrors skill-discovery.escapeXml). */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * A compact domain index appended to the main catalog. It intentionally
 * contains only domain names, descriptions and counts — never skill names or
 * descriptions — so the model pays O(domains), not O(skills), at connect time.
 */
export function renderDomainIndex(routing: DomainRouting): string {
  if (!routing.enabled || routing.domains.length === 0) return "";
  const lines: string[] = [
    "<skill_domains>",
    "Most skills are grouped into domains and are NOT listed in <available_skills> above. " +
      "Use `find-skills-for-task` (see <skill_preflight>) to discover them: pass `task` to have " +
      "the server pick a domain, or `domain` to expand a named one. Then call `load-skill` with " +
      "the chosen name. A skill with no domain is global and already listed above.",
  ];
  for (const domain of routing.domains) {
    lines.push("<domain>");
    lines.push(`<name>${escapeXml(domain.name)}</name>`);
    if (domain.description) lines.push(`<description>${escapeXml(domain.description)}</description>`);
    lines.push(`<skill_count>${domain.skills.length}</skill_count>`);
    if (domain.triggers.length > 0) {
      lines.push(`<triggers>${escapeXml(domain.triggers.join(", "))}</triggers>`);
    }
    if (domain.antiTriggers.length > 0) {
      lines.push(`<anti_triggers>${escapeXml(domain.antiTriggers.join(", "))}</anti_triggers>`);
    }
    lines.push("</domain>");
  }
  lines.push("</skill_domains>");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Task-aware skill discovery (fork addition)
//
// `triggers` / `antiTriggers` used to be advisory metadata only: the model had
// to decide for itself whether to look for a skill, which progressive
// disclosure makes hard because domain skills are absent from the main
// catalog. This turns them into executable routing rules: the caller submits a
// one-line task description and the server picks the domain(s) to expand.
// ---------------------------------------------------------------------------

/** How one domain scored against a free-form task description. */
export interface TaskDomainMatch {
  name: string;
  score: number;
  /** Explicit triggers that matched. */
  hits: string[];
  /** Weak evidence from the domain description. */
  weakHits: string[];
  /** Anti-triggers that matched; a match vetoes this domain entirely. */
  antiHits: string[];
  blocked: boolean;
  domain: RoutedDomain;
}

export const TASK_MATCH_MIN_SCORE = 3;
export const TASK_MATCH_RATIO = 0.7;
export const TASK_MATCH_MAX_DOMAINS = 2;

function hasCJK(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether a trigger term occurs in a normalized task string. CJK terms match
 * as substrings; plain ASCII terms require word boundaries so "designer" does
 * not match the trigger "design". Terms containing punctuation (Next.js,
 * AGENTS.md, E2E) additionally fall back to a literal substring match.
 */
function triggerOccurrences(task: string, term: string): number {
  const needle = term.trim().toLowerCase();
  if (!needle) return 0;
  if (hasCJK(needle)) return task.includes(needle) ? 1 : 0;
  const boundary = new RegExp(`(^|[^a-z0-9])${escapeRegExp(needle)}(?=$|[^a-z0-9])`);
  if (boundary.test(task)) return 1;
  return /[^a-z0-9]/.test(needle) && task.includes(needle) ? 1 : 0;
}

/** Score every domain against a task. Pure, deterministic, and side-effect free. */
export function scoreTaskAgainstDomains(routing: DomainRouting, task: string): TaskDomainMatch[] {
  const normalized = task.toLowerCase().replace(/\s+/g, " ").trim();
  const matches: TaskDomainMatch[] = [];

  for (const domain of routing.domains) {
    let score = 0;
    const hits: string[] = [];
    const antiHits: string[] = [];
    const weakHits: string[] = [];

    for (const trigger of domain.triggers) {
      if (triggerOccurrences(normalized, trigger) > 0) {
        score += hasCJK(trigger) ? 3 : 2;
        hits.push(trigger);
      }
    }
    for (const anti of domain.antiTriggers) {
      if (triggerOccurrences(normalized, anti) > 0) antiHits.push(anti);
    }

    // Weak evidence from the prose description, only when not vetoed and only
    // for words not already covered by an explicit trigger.
    if (antiHits.length === 0) {
      const words =
        domain.description.toLowerCase().match(/[a-z][a-z0-9.+#-]{2,}|[\u3400-\u9fff]{2,4}/g) ?? [];
      for (const word of new Set(words)) {
        if (hits.some((h) => h.toLowerCase().includes(word) || word.includes(h.toLowerCase()))) continue;
        if (triggerOccurrences(normalized, word) > 0) {
          score += 1;
          weakHits.push(word);
        }
      }
    }

    matches.push({
      name: domain.name,
      score: antiHits.length > 0 ? 0 : score,
      hits,
      weakHits,
      antiHits,
      blocked: antiHits.length > 0,
      domain,
    });
  }

  return matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

/**
 * Domains worth expanding for this task. A vetoed domain is never suggested;
 * the runner-up must be close to the winner (and clear the minimum score), so
 * a generic word like "design" does not drag in a second unrelated domain.
 */
export function suggestDomainsForTask(routing: DomainRouting, task: string): TaskDomainMatch[] {
  if (!routing.enabled || routing.domains.length === 0) return [];
  const scored = scoreTaskAgainstDomains(routing, task);
  const best = scored[0];
  if (!best || best.blocked || best.score < TASK_MATCH_MIN_SCORE) return [];
  return scored
    .filter(
      (m) =>
        !m.blocked &&
        m.score >= TASK_MATCH_MIN_SCORE &&
        m.score >= best.score * TASK_MATCH_RATIO
    )
    .slice(0, TASK_MATCH_MAX_DOMAINS);
}

/** One-line stderr summary of the active routing policy. */
export function describeDomainRouting(routing: DomainRouting): string {
  if (!routing.enabled) return "domain routing: OFF (all skills listed globally)";
  const parts = routing.domains.map((d) => `${d.name}=${d.skills.length}`);
  return (
    `domain routing: ON — ${routing.domains.length} domain(s) [${parts.join(", ")}], ` +
    `${routing.globalSkills.length} global skill(s); map: ${routing.mapPath ?? "(none)"}`
  );
}
