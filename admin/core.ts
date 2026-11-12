/**
 * Domain admin console — core logic (fork addition).
 *
 * This module is deliberately dependency-light and independent of the MCP
 * server: it only touches the filesystem and knows nothing about HTTP. The
 * scanning and routing rules mirror `src/skill-discovery.ts` and
 * `src/domain-router.ts` so what the UI shows matches what the server does.
 *
 * Path handling is entirely configuration-driven. No machine-specific paths
 * are baked in here.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DomainDefinition {
  name: string;
  description?: string;
  triggers?: string[];
  antiTriggers?: string[];
  skills: string[];
}

export interface DomainMap {
  version?: number;
  domains: DomainDefinition[];
}

export interface AdminConfig {
  skillsDir: string;
  mapPath: string;
}

export interface SkillRecord {
  dirName: string;
  /** Frontmatter `name` (base name, unqualified). */
  name: string;
  description: string;
  /** Absolute path to SKILL.md. */
  skillPath: string;
  frontmatter: Record<string, unknown>;
  /** Full SKILL.md text, for the detail view. */
  content: string;
  fileCount: number;
  totalBytes: number;
  topDirs: string[];
  /** Symlinks / junctions are skipped by the MCP server's discovery walk. */
  isLink: boolean;
  valid: boolean;
  issue?: string;
  /** `disable-model-invocation: true` keeps a skill out of the model catalog. */
  modelInvocable: boolean;
  /** Resolved domain (null = global), mirroring the server's routing plan. */
  domain: string | null;
  /** How the assignment was made — important when frontmatter disagrees with the map. */
  domainSource: "map" | "frontmatter" | null;
}

export interface AdminStats {
  total: number;
  valid: number;
  linked: number;
  eligible: number;
  global: number;
  domainCount: number;
  byDomain: Record<string, number>;
  flatCatalogBytes: number;
  routedCatalogBytes: number;
  savedPercent: number;
}

export interface AdminState extends AdminConfig {
  skills: SkillRecord[];
  version: number;
  domains: DomainDefinition[];
  stats: AdminStats;
  warnings: string[];
  serverTime: string;
}

export interface ValidationResult {
  /** Normalized map, safe to write when `errors` is empty. */
  map: DomainMap;
  /** Blocking problems: never write when non-empty. */
  errors: string[];
  /** Non-blocking notes worth showing in the UI. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Skill discovery (mirrors src/skill-discovery.ts)
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const MAX_WALK_DEPTH = 12;

function findSkillMd(dir: string): string | null {
  for (const name of ["SKILL.md", "skill.md"]) {
    const candidate = path.join(dir, name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not present
    }
  }
  return null;
}

function parseFrontmatter(content: string): { metadata: Record<string, unknown>; body: string } {
  if (!content.startsWith("---")) {
    throw new Error("SKILL.md must start with YAML frontmatter (---)");
  }
  const match = content.match(FRONTMATTER_RE);
  if (!match) throw new Error("SKILL.md frontmatter not properly closed with ---");
  const metadata = parseYaml(match[1]) as unknown;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw new Error("SKILL.md frontmatter must be a YAML mapping");
  }
  return { metadata: metadata as Record<string, unknown>, body: content.slice(match[0].length).trim() };
}

function summarizeFiles(dir: string): { fileCount: number; totalBytes: number; topDirs: string[] } {
  let fileCount = 0;
  let totalBytes = 0;
  const topDirs = new Set<string>();

  const walk = (current: string, depth: number, isTop: boolean): void => {
    if (depth > MAX_WALK_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (isTop && entry.isDirectory()) topDirs.add(entry.name);
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1, false);
      } else if (entry.isFile()) {
        fileCount += 1;
        try {
          totalBytes += fs.statSync(full).size;
        } catch {
          // file vanished mid-walk
        }
      }
    }
  };

  walk(dir, 0, true);
  return { fileCount, totalBytes, topDirs: [...topDirs].sort() };
}

function blankRecord(dirName: string, isLink: boolean, issue: string): SkillRecord {
  return {
    dirName,
    name: "",
    description: "",
    skillPath: "",
    frontmatter: {},
    content: "",
    fileCount: 0,
    totalBytes: 0,
    topDirs: [],
    isLink,
    valid: false,
    issue,
    modelInvocable: false,
    domain: null,
    domainSource: null,
  };
}

/** Frontmatter keys that can tag a skill with one or more domains. */
export function frontmatterDomains(skill: SkillRecord): string[] {
  const raw = skill.frontmatter["domain"] ?? skill.frontmatter["domains"];
  const values = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  return values.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim().toLowerCase());
}

/**
 * Scan the configured skills root. Rules match the server: immediate
 * subdirectories only, `SKILL.md` (or `skill.md`) required, frontmatter with
 * non-empty `name` and `description` required. Symlinks are listed but flagged
 * as skipped, so the UI can surface them instead of hiding the problem.
 */
export function scanSkills(skillsDir: string): SkillRecord[] {
  if (!skillsDir || !fs.existsSync(skillsDir)) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const records: SkillRecord[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;

    if (entry.isSymbolicLink()) {
      records.push(blankRecord(entry.name, true, "符号链接 / junction：服务端发现时会跳过"));
      continue;
    }
    if (!entry.isDirectory()) continue;

    const skillDir = path.join(skillsDir, entry.name);
    const skillMd = findSkillMd(skillDir);
    if (!skillMd) {
      records.push(blankRecord(entry.name, false, "缺少 SKILL.md / skill.md"));
      continue;
    }

    let content: string;
    try {
      content = fs.readFileSync(skillMd, "utf-8");
    } catch (error) {
      records.push(blankRecord(entry.name, false, `读取失败：${String(error)}`));
      continue;
    }

    let metadata: Record<string, unknown>;
    try {
      metadata = parseFrontmatter(content).metadata;
    } catch (error) {
      records.push(blankRecord(entry.name, false, error instanceof Error ? error.message : String(error)));
      continue;
    }

    const name = typeof metadata.name === "string" ? metadata.name.trim() : "";
    const description = typeof metadata.description === "string" ? metadata.description.trim() : "";
    if (!name || !description) {
      records.push(blankRecord(entry.name, false, "frontmatter 缺少 name 或 description"));
      continue;
    }

    const summary = summarizeFiles(skillDir);
    records.push({
      dirName: entry.name,
      name,
      description,
      skillPath: skillMd,
      frontmatter: metadata,
      content,
      fileCount: summary.fileCount,
      totalBytes: summary.totalBytes,
      topDirs: summary.topDirs,
      isLink: false,
      valid: true,
      modelInvocable: metadata["disable-model-invocation"] !== true,
      domain: null,
      domainSource: null,
    });
  }

  return records.sort((a, b) => a.dirName.localeCompare(b.dirName));
}

// ---------------------------------------------------------------------------
// Domain map: read, validate, write
// ---------------------------------------------------------------------------

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
}

/** Read and strictly validate a domain map file. Throws on any problem. */
export function readDomainMap(mapPath: string): DomainMap {
  let text: string;
  try {
    text = fs.readFileSync(mapPath, "utf-8");
  } catch (error) {
    throw new Error(`无法读取领域映射 ${mapPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${mapPath} 不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as DomainMap).domains)) {
    throw new Error(`${mapPath}: 需要包含 domains 数组的对象`);
  }

  const domains: DomainDefinition[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of ((parsed as DomainMap).domains as unknown[]).entries()) {
    if (typeof raw !== "object" || raw === null) throw new Error(`${mapPath}: domains[${i}] 不是对象`);
    const def = raw as Partial<DomainDefinition>;
    if (typeof def.name !== "string" || def.name.trim() === "") {
      throw new Error(`${mapPath}: domains[${i}] 缺少非空 name`);
    }
    const name = def.name.trim();
    if (seen.has(name.toLowerCase())) throw new Error(`${mapPath}: 领域名重复 "${name}"`);
    seen.add(name.toLowerCase());
    domains.push({
      name,
      description: typeof def.description === "string" ? def.description.trim() : "",
      triggers: toStringArray(def.triggers),
      antiTriggers: toStringArray(def.antiTriggers),
      skills: toStringArray(def.skills),
    });
  }
  return { version: typeof (parsed as DomainMap).version === "number" ? (parsed as DomainMap).version : 1, domains };
}

/** Known identifiers for a skill: base name, directory name, qualified name. */
export function skillKeys(skill: SkillRecord, prefix: string): string[] {
  const keys = [skill.name.toLowerCase(), skill.dirName.toLowerCase()];
  if (prefix) keys.push(`${prefix}__${skill.name}`.toLowerCase());
  return [...new Set(keys)];
}

/**
 * Validate and normalize a domain map coming from the UI.
 *
 * Blocking errors: bad structure, empty/duplicate domain names, a skill listed
 * in more than one domain (the server would silently keep the first one).
 * Unknown skill names are only warnings — a portable map may legitimately
 * reference skills that are not installed on this machine yet.
 */
export function validateDomainMap(raw: unknown, skills: SkillRecord[], prefix: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const normalized: DomainDefinition[] = [];

  if (typeof raw !== "object" || raw === null) {
    return { map: { version: 1, domains: [] }, errors: ["请求体必须是对象"], warnings };
  }
  const candidate = raw as { version?: unknown; domains?: unknown };
  if (!Array.isArray(candidate.domains)) {
    return { map: { version: 1, domains: [] }, errors: ["domains 必须是数组"], warnings };
  }

  const known = new Map<string, SkillRecord>();
  for (const skill of skills) {
    for (const key of skillKeys(skill, prefix)) known.set(key, skill);
  }

  const seenDomains = new Set<string>();
  const assigned = new Map<string, string>(); // skill key -> domain name

  for (const [i, item] of (candidate.domains as unknown[]).entries()) {
    if (typeof item !== "object" || item === null) {
      errors.push(`domains[${i}] 不是对象`);
      continue;
    }
    const def = item as Record<string, unknown>;
    const name = typeof def.name === "string" ? def.name.trim() : "";
    if (!name) {
      errors.push(`domains[${i}] 缺少非空 name`);
      continue;
    }
    if (seenDomains.has(name.toLowerCase())) {
      errors.push(`领域名重复："${name}"`);
      continue;
    }
    seenDomains.add(name.toLowerCase());

    if (def.description !== undefined && typeof def.description !== "string") {
      warnings.push(`领域 "${name}" 的 description 不是字符串，已忽略`);
    }
    for (const field of ["triggers", "antiTriggers"] as const) {
      if (def[field] !== undefined && !Array.isArray(def[field])) {
        warnings.push(`领域 "${name}" 的 ${field} 不是数组，已忽略`);
      }
    }
    if (!Array.isArray(def.skills)) {
      errors.push(`领域 "${name}" 的 skills 必须是数组`);
      continue;
    }

    const members: string[] = [];
    const seenInDomain = new Set<string>();
    for (const rawName of def.skills as unknown[]) {
      if (typeof rawName !== "string" || rawName.trim() === "") {
        errors.push(`领域 "${name}" 的 skills 含非字符串或空值`);
        continue;
      }
      const trimmed = rawName.trim();
      const key = trimmed.toLowerCase();
      const skill = known.get(key);
      if (!skill) warnings.push(`领域 "${name}" 引用的技能 "${trimmed}" 在当前技能库中不存在（服务端会忽略）`);
      // De-duplicate by resolved skill, not by raw string: a base name and a
      // qualified name can point at the same skill, and the server would warn
      // about "already assigned to another domain" on duplicates.
      const identity = skill ? skill.dirName : key;
      if (seenInDomain.has(identity)) continue;
      seenInDomain.add(identity);
      const previous = assigned.get(identity);
      if (previous && previous.toLowerCase() !== name.toLowerCase()) {
        errors.push(`技能 "${trimmed}" 同时出现在领域 "${previous}" 和 "${name}"；一个技能只能属于一个领域`);
      } else {
        assigned.set(identity, name);
      }
      members.push(trimmed);
    }

    normalized.push({
      name,
      description: typeof def.description === "string" ? def.description.trim() : "",
      triggers: toStringArray(def.triggers),
      antiTriggers: toStringArray(def.antiTriggers),
      skills: members,
    });
  }

  const version = typeof candidate.version === "number" ? candidate.version : 1;
  return { map: { version, domains: normalized }, errors, warnings };
}

function backupStamp(): string {
  const d = new Date();
  const p = (n: number, width = 2): string => String(n).padStart(width, "0");
  // Milliseconds matter: two saves in the same second must not overwrite
  // each other's backup.
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`;
}

function pruneBackups(mapPath: string, keep = 5): void {
  const dir = path.dirname(mapPath);
  const base = path.basename(mapPath);
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped}\\.bak-\\d{8}-\\d{9}(?:-\\d+)?$`);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => re.test(f)).sort().reverse();
  } catch {
    return;
  }
  for (const file of files.slice(keep)) {
    try {
      fs.unlinkSync(path.join(dir, file));
    } catch {
      // best effort
    }
  }
}

/** Atomically write the map, keeping a timestamped backup of the old file. */
export function writeDomainMap(mapPath: string, map: DomainMap): { backupPath: string | null } {
  const dir = path.dirname(mapPath);
  fs.mkdirSync(dir, { recursive: true });

  let backupPath: string | null = null;
  if (fs.existsSync(mapPath)) {
    const stamp = backupStamp();
    let candidate = `${mapPath}.bak-${stamp}`;
    let suffix = 1;
    while (fs.existsSync(candidate)) candidate = `${mapPath}.bak-${stamp}-${suffix++}`;
    backupPath = candidate;
    fs.copyFileSync(mapPath, backupPath);
    pruneBackups(mapPath);
  }

  const tmp = `${mapPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`, "utf-8");
    fs.renameSync(tmp, mapPath);
  } catch (error) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      // best effort
    }
    throw error;
  }
  return { backupPath };
}

// ---------------------------------------------------------------------------
// State assembly
// ---------------------------------------------------------------------------

function estimateSkillXmlBytes(skill: SkillRecord, prefix: string): number {
  const xml =
    `<skill>\n<name>${skill.name}</name>\n<description>${skill.description}</description>\n` +
    `<uri>skill://${prefix}/${skill.name}/SKILL.md</uri>\n<location>${skill.skillPath}</location>\n</skill>\n`;
  return Buffer.byteLength(xml, "utf-8");
}

function estimateDomainIndexBytes(def: DomainDefinition, count: number): number {
  const xml =
    `<domain>\n<name>${def.name}</name>\n<description>${def.description ?? ""}</description>\n` +
    `<skill_count>${count}</skill_count>\n<triggers>${(def.triggers ?? []).join(", ")}</triggers>\n` +
    `<anti_triggers>${(def.antiTriggers ?? []).join(", ")}</anti_triggers>\n</domain>\n`;
  return Buffer.byteLength(xml, "utf-8");
}

/**
 * Build the full state the UI renders. Domain assignment mirrors
 * `routeSkills`: map entries win, frontmatter `domain`/`domains` is a portable
 * fallback, first match wins, untagged skills are global.
 */
export function computeState(config: AdminConfig): AdminState {
  const warnings: string[] = [];
  const skillsDir = config.skillsDir ? path.resolve(config.skillsDir) : "";
  const mapPath = config.mapPath ? path.resolve(config.mapPath) : "";
  const prefix = skillsDir ? path.basename(skillsDir) : "";

  const skills = scanSkills(skillsDir);
  if (!skillsDir) {
    warnings.push("尚未配置技能库目录：请在设置中填写，或用 --skills-dir=<path> 启动。");
  } else if (!fs.existsSync(skillsDir)) {
    warnings.push(`技能库目录不存在：${skillsDir}`);
  } else if (skills.length === 0) {
    warnings.push(`技能库目录为空或未发现技能：${skillsDir}`);
  }

  let map: DomainMap = { version: 1, domains: [] };
  if (!mapPath) {
    warnings.push("尚未配置领域映射路径。");
  } else {
    try {
      map = readDomainMap(mapPath);
    } catch (error) {
      warnings.push(`${error instanceof Error ? error.message : String(error)}；将以空映射启动，保存时会创建文件。`);
    }
  }

  // Resolve assignments (same precedence as the server).
  const byKey = new Map<string, SkillRecord>();
  for (const skill of skills) {
    if (!skill.valid || !skill.modelInvocable) continue;
    for (const key of skillKeys(skill, prefix)) byKey.set(key, skill);
  }
  const claimed = new Set<string>(); // dirName

  for (const def of map.domains) {
    for (const rawName of def.skills) {
      const skill = byKey.get(rawName.toLowerCase());
      if (!skill) {
        warnings.push(`领域 "${def.name}" 引用的技能 "${rawName}" 未发现（服务端会忽略）`);
        continue;
      }
      if (claimed.has(skill.dirName)) {
        warnings.push(`领域 "${def.name}" 中的 "${rawName}" 已被其他领域认领（服务端取首个）`);
        continue;
      }
      skill.domain = def.name;
      skill.domainSource = "map";
      claimed.add(skill.dirName);
    }
    for (const skill of skills) {
      if (!skill.valid || !skill.modelInvocable || claimed.has(skill.dirName)) continue;
      if (frontmatterDomains(skill).includes(def.name.toLowerCase())) {
        skill.domain = def.name;
        skill.domainSource = "frontmatter";
        claimed.add(skill.dirName);
      }
    }
  }

  const eligible = skills.filter((s) => s.valid && s.modelInvocable && !s.isLink);
  const globalSkills = eligible.filter((s) => s.domain === null);
  const byDomain: Record<string, number> = {};
  for (const def of map.domains) byDomain[def.name] = 0;
  for (const skill of eligible) {
    if (skill.domain && byDomain[skill.domain] !== undefined) byDomain[skill.domain] += 1;
  }

  let flatCatalogBytes = 0;
  for (const skill of eligible) flatCatalogBytes += estimateSkillXmlBytes(skill, prefix);
  let routedCatalogBytes = 0;
  for (const skill of globalSkills) routedCatalogBytes += estimateSkillXmlBytes(skill, prefix);
  for (const def of map.domains) routedCatalogBytes += estimateDomainIndexBytes(def, byDomain[def.name] ?? 0);

  const stats: AdminStats = {
    total: skills.length,
    valid: skills.filter((s) => s.valid).length,
    linked: skills.filter((s) => s.isLink).length,
    eligible: eligible.length,
    global: globalSkills.length,
    domainCount: map.domains.length,
    byDomain,
    flatCatalogBytes,
    routedCatalogBytes,
    savedPercent: flatCatalogBytes > 0 ? Math.round(((flatCatalogBytes - routedCatalogBytes) / flatCatalogBytes) * 1000) / 10 : 0,
  };

  return {
    skillsDir,
    mapPath,
    skills,
    version: map.version ?? 1,
    domains: map.domains,
    stats,
    warnings,
    serverTime: new Date().toISOString(),
  };
}
