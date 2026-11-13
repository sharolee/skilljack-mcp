/**
 * Domain admin console — browser half (fork addition).
 *
 * Plain TypeScript + DOM, no framework. All strings coming from the API are
 * escaped before being inserted as HTML: skill descriptions and SKILL.md text
 * are user-authored files, not trusted input.
 */

// ---------------------------------------------------------------------------
// Types (mirrors admin/core.ts)
// ---------------------------------------------------------------------------

interface DomainDef {
  name: string;
  description?: string;
  triggers?: string[];
  antiTriggers?: string[];
  skills: string[];
}

interface Skill {
  dirName: string;
  name: string;
  description: string;
  skillPath: string;
  frontmatter: Record<string, unknown>;
  content: string;
  fileCount: number;
  totalBytes: number;
  topDirs: string[];
  isLink: boolean;
  valid: boolean;
  issue?: string;
  modelInvocable: boolean;
  domain: string | null;
  domainSource: "map" | "frontmatter" | null;
}

interface State {
  skillsDir: string;
  mapPath: string;
  /** Where the Paths dialog persists configuration (fork). */
  configStorePath?: string;
  /** Which source currently wins for the skills directory. */
  configSource?: "cli" | "env" | "config" | "none";
  skills: Skill[];
  version: number;
  domains: DomainDef[];
  stats: {
    total: number; valid: number; linked: number; eligible: number; global: number; userCommand: number;
    domainCount: number; byDomain: Record<string, number>;
    flatCatalogBytes: number; routedCatalogBytes: number; savedPercent: number;
  };
  warnings: string[];
  serverTime: string;
}

interface SaveResponse {
  ok?: boolean;
  backupPath?: string | null;
  warnings?: string[];
  state?: State;
  error?: string;
  errors?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少页面元素 #${id}`);
  return node as T;
}

function esc(value: unknown): string {
  const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(value ?? "").replace(/[&<>"']/g, (c) => map[c]);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function basename(p: string): string {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

let toastTimer: number | undefined;
function toast(message: string, kind: "success" | "error" | "info" = "info"): void {
  const node = el("toast");
  node.textContent = message;
  node.className = `toast toast-${kind}`;
  node.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { node.hidden = true; }, 4200);
}

function notice(message: string): void {
  const node = el("notice");
  if (!message) { node.hidden = true; return; }
  node.textContent = message;
  node.hidden = false;
}

function showModal(id: string): void { el(id).hidden = false; }
function hideModal(id: string): void { el(id).hidden = true; }

// ---------------------------------------------------------------------------
// Mutable UI state
// ---------------------------------------------------------------------------

let state: State | null = null;
let draft: DomainDef[] = [];
let dirty = false;
let selected = new Set<string>();
let searchQuery = "";
let filterValue = "__all__";

function frontmatterTags(skill: Skill): string[] {
  const raw = skill.frontmatter["domain"] ?? skill.frontmatter["domains"];
  const values = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  return values.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim().toLowerCase());
}

function skillByRaw(raw: string): Skill | undefined {
  if (!state) return undefined;
  const key = raw.trim().toLowerCase();
  const prefix = basename(state.skillsDir);
  return state.skills.find((s) =>
    s.name.toLowerCase() === key ||
    s.dirName.toLowerCase() === key ||
    (prefix ? `${prefix}__${s.name}`.toLowerCase() === key : false)
  );
}

/** Mirrors the server: map entries first, frontmatter as portable fallback. */
function effectiveDomain(skill: Skill): string | null {
  for (const domain of draft) {
    if (domain.skills.some((raw) => skillByRaw(raw)?.dirName === skill.dirName)) return domain.name;
  }
  const tags = frontmatterTags(skill);
  for (const domain of draft) {
    if (tags.includes(domain.name.trim().toLowerCase())) return domain.name;
  }
  return null;
}

/**
 * Top-level classification used by the table and filters. Three routing
 * categories — 用户命令 (slash-only, user-triggered only), 领域 (routed), 全局
 * (always listed) — plus an "issue" bucket for invalid / link entries that the
 * server skips. User-command skills are read-only for domain assignment.
 */
function skillCategory(skill: Skill): "user-command" | "domain" | "global" | "issue" {
  if (!skill.valid || skill.isLink) return "issue";
  if (!skill.modelInvocable) return "user-command";
  return effectiveDomain(skill) === null ? "global" : "domain";
}

function eligibleSkills(): Skill[] {
  return state ? state.skills.filter((s) => s.valid && s.modelInvocable && !s.isLink) : [];
}

function estimateSkillBytes(skill: Skill, prefix: string): number {
  const xml =
    `<skill>\n<name>${skill.name}</name>\n<description>${skill.description}</description>\n` +
    `<uri>skill://${prefix}/${skill.name}/SKILL.md</uri>\n<location>${skill.skillPath}</location>\n</skill>\n`;
  return new TextEncoder().encode(xml).length;
}

function estimateDomainBytes(domain: DomainDef, count: number): number {
  const xml =
    `<domain>\n<name>${domain.name}</name>\n<description>${domain.description ?? ""}</description>\n` +
    `<skill_count>${count}</skill_count>\n<triggers>${(domain.triggers ?? []).join(", ")}</triggers>\n` +
    `<anti_triggers>${(domain.antiTriggers ?? []).join(", ")}</anti_triggers>\n</domain>\n`;
  return new TextEncoder().encode(xml).length;
}

/** Live preview of the main catalog cost for the current (possibly unsaved) draft. */
function previewStats(): { global: number; flat: number; routed: number; saved: number; counts: Record<string, number> } {
  if (!state) return { global: 0, flat: 0, routed: 0, saved: 0, counts: {} };
  const prefix = basename(state.skillsDir);
  const eligible = eligibleSkills();
  const counts: Record<string, number> = {};
  for (const domain of draft) counts[domain.name] = 0;
  let routed = 0;
  let flat = 0;
  for (const skill of eligible) {
    flat += estimateSkillBytes(skill, prefix);
    const domain = effectiveDomain(skill);
    if (domain === null) routed += estimateSkillBytes(skill, prefix);
    else if (counts[domain] !== undefined) counts[domain] += 1;
  }
  for (const domain of draft) routed += estimateDomainBytes(domain, counts[domain.name] ?? 0);
  return {
    global: eligible.filter((s) => effectiveDomain(s) === null).length,
    flat,
    routed,
    saved: flat > 0 ? Math.round(((flat - routed) / flat) * 1000) / 10 : 0,
    counts,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderStats(): void {
  if (!state) return;
  const p = previewStats();
  const eligible = eligibleSkills().length;
  const assigned = eligible - p.global;
  // The hero KPI's underline shows how much of the library is behind a domain.
  const coverage = eligible > 0 ? Math.round((assigned / eligible) * 100) : 0;
  const cards: { label: string; value: string; sub: string; tone: string; tip?: string }[] = [
    {
      label: "技能总数", value: `${state.stats.valid}`,
      sub: `${state.stats.total} 个目录${state.stats.linked ? ` · ${state.stats.linked} 个链接被跳过` : ""}`,
      tone: "hero", tip: `已归入领域 ${assigned} / ${eligible} 个技能（${coverage}%）`,
    },
    { label: "全局技能", value: `${p.global}`, sub: dirty ? "预览（未保存）" : "主 catalog 全量列出", tone: "normal" },
    { label: "领域", value: `${draft.length}`, sub: `${assigned} 个技能按需加载`, tone: "normal" },
    {
      label: "用户命令", value: `${state.stats.userCommand}`,
      sub: "仅 /命令 触发 · 不参与路由", tone: "muted",
      tip: "标记为 disable-model-invocation：只能由用户手动调用，模型不自动发现，也不能分配到领域",
    },
    { label: "主 catalog 估算", value: formatBytes(p.routed), sub: `约 ${Math.round(p.routed / 4)} tokens${dirty ? " · 预览" : ""}`, tone: "accent" },
    { label: "对比全平铺节省", value: `${p.saved}%`, sub: `${formatBytes(p.flat)} → ${formatBytes(p.routed)}`, tone: "success" },
  ];
  el("stats").innerHTML = cards.map((c, i) => `
    <div class="kpi" data-tone="${esc(c.tone)}" title="${esc(`${c.label}：${c.value} · ${c.sub}${c.tip ? ` · ${c.tip}` : ""}`)}">
      <div class="kpi-label">${esc(c.label)}</div>
      <div class="kpi-value">${esc(c.value)}</div>
      <div class="kpi-sub">${esc(c.sub)}</div>
      ${i === 0 ? `<div class="kpi-track"><div class="kpi-fill" style="width:${coverage}%"></div></div>` : ""}
    </div>
  `).join("");
}

function renderFilters(): void {
  const select = el<HTMLSelectElement>("filterDomain");
  const options = [
    `<option value="__all__">全部状态</option>`,
    `<option value="__global__">仅全局技能</option>`,
    `<option value="__usercmd__">仅用户命令（/命令）</option>`,
    `<option value="__issues__">仅异常 / 链接</option>`,
    ...draft.map((d) => `<option value="d:${esc(d.name)}">领域：${esc(d.name)}</option>`),
  ];
  if (!options.some((o) => o.includes(`value="${filterValue}"`))) filterValue = "__all__";
  select.innerHTML = options.join("");
  select.value = filterValue;
}

function visibleSkills(): Skill[] {
  if (!state) return [];
  const q = searchQuery.trim().toLowerCase();
  return state.skills.filter((s) => {
    const domain = effectiveDomain(s);
    if (q) {
      const haystack = [
        s.name, s.dirName, s.description, s.skillPath, domain ?? "全局",
        ...Object.values(s.frontmatter).map((v) => (typeof v === "string" ? v : "")),
      ].join(" ").toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    if (filterValue === "__global__" && skillCategory(s) !== "global") return false;
    if (filterValue === "__usercmd__" && skillCategory(s) !== "user-command") return false;
    if (filterValue === "__issues__" && s.valid && !s.isLink) return false;
    if (filterValue.startsWith("d:") && domain !== filterValue.slice(2)) return false;
    return true;
  });
}

function statusBadge(skill: Skill): string {
  if (skill.isLink) return `<span class="tag tag-danger">链接跳过</span>`;
  if (!skill.valid) return `<span class="tag tag-danger">无效</span>`;
  return "";
}

function domainBadge(skill: Skill): string {
  const domain = effectiveDomain(skill);
  if (domain === null) return `<span class="tag tag-plain">全局</span>`;
  const fromFrontmatter = !draft.some((d) => d.name === domain && d.skills.some((raw) => skillByRaw(raw)?.dirName === skill.dirName));
  const changed = skill.domain !== domain;
  return `<span class="tag tag-domain">${esc(domain)}</span>` +
    (fromFrontmatter ? `<span class="tag tag-warning" title="由 SKILL.md frontmatter 的 domain 字段归入，需改 SKILL.md 才能移出">frontmatter</span>` : "") +
    (changed ? `<span class="dot-unsaved" title="未保存"></span>` : "");
}

function renderRows(): void {
  if (!state) return;
  const rows = visibleSkills();
  el("skillCount").textContent = `${rows.length} / ${state.skills.length}`;

  el("skillRows").innerHTML = rows.map((s) => {
    const assignable = s.valid && !s.isLink && s.modelInvocable;
    const checked = selected.has(s.dirName) && assignable;
    const domainCell = s.modelInvocable
      ? domainBadge(s)
      : `<span class="tag tag-usercmd" title="仅用户手动触发（/命令）：模型不自动调用，也不参与领域路由，此类技能不能分配到领域">用户命令</span>`;
    return `
      <tr data-id="${esc(s.dirName)}" class="${s.valid ? "" : "row-invalid"}">
        <td class="col-check">
          <input type="checkbox" class="row-check" ${checked ? "checked" : ""} ${assignable ? "" : "disabled"} aria-label="选择 ${esc(s.dirName)}">
        </td>
        <td>
          <div class="skill-name">${esc(s.name || s.dirName)} ${statusBadge(s)}</div>
          <div class="skill-meta" title="${esc(s.skillPath)}">${esc(s.dirName)}</div>
          ${s.issue ? `<div class="skill-issue">${esc(s.issue)}</div>` : ""}
        </td>
        <td class="col-desc"><span title="${esc(s.description)}">${esc(truncate(s.description || "—", 110))}</span></td>
        <td class="col-domain">${domainCell}</td>
        <td class="col-num">${s.valid ? esc(s.fileCount) : "—"}</td>
        <td class="col-act"><button class="btn btn-sm btn-ghost btn-detail" data-id="${esc(s.dirName)}">详情</button></td>
      </tr>
    `;
  }).join("");

  el("emptyState").hidden = rows.length > 0;
  el("emptyState").textContent = state.skills.length === 0
    ? "尚未发现技能。检查右上角的「路径设置」是否指向技能库根目录。"
    : "没有匹配的技能，换个关键词或筛选条件试试。";

  const all = el<HTMLInputElement>("selectAll");
  const assignableVisible = rows.filter((s) => s.valid && !s.isLink && s.modelInvocable);
  all.checked = assignableVisible.length > 0 && assignableVisible.every((s) => selected.has(s.dirName));
  all.disabled = assignableVisible.length === 0;
}

function renderDomains(): void {
  el("domainCount").textContent = `${draft.length}`;
  const counts = previewStats().counts;
  el("domainList").innerHTML = draft.length === 0
    ? `<div class="empty-inline">还没有领域。点击「+ 新建领域」，或在左侧多选技能后批量分配。</div>`
    : draft.map((d, i) => {
      const members = d.skills.map((raw) => {
        const s = skillByRaw(raw);
        return `<span class="chip" title="${esc(raw)}">${esc(s?.name ?? raw)}<button class="chip-x" data-index="${i}" data-raw="${esc(raw)}" title="移回全局">×</button></span>`;
      }).join("");
      const fmCount = state ? eligibleSkills().filter((s) =>
        frontmatterTags(s).includes(d.name.trim().toLowerCase()) &&
        !d.skills.some((raw) => skillByRaw(raw)?.dirName === s.dirName)
      ).length : 0;
      return `
        <div class="domain-card" data-index="${i}">
          <div class="dc-head">
            <input class="dc-name" data-index="${i}" value="${esc(d.name)}" aria-label="领域名称" spellcheck="false">
            <span class="dc-count">${counts[d.name] ?? 0} 个技能</span>
            <button class="icon-btn dc-del" data-index="${i}" title="删除领域（成员移回全局）" aria-label="删除领域">×</button>
          </div>
          <label class="dc-field"><span>描述</span><input class="dc-desc" data-index="${i}" value="${esc(d.description ?? "")}" placeholder="什么时候该展开这个领域"></label>
          <label class="dc-field"><span>触发词</span><input class="dc-triggers" data-index="${i}" value="${esc((d.triggers ?? []).join(", "))}" placeholder="逗号分隔，中英文皆可"></label>
          <label class="dc-field"><span>排除词</span><input class="dc-anti" data-index="${i}" value="${esc((d.antiTriggers ?? []).join(", "))}" placeholder="容易误命中的反面场景"></label>
          <div class="dc-members">${members || `<span class="muted">暂无成员</span>`}</div>
          ${fmCount > 0 ? `<div class="dc-note">另有 ${fmCount} 个技能由 SKILL.md 的 <code>domain</code> 自动归入；要移出需修改该技能文件。</div>` : ""}
        </div>
      `;
    }).join("");
}

function renderBulkbar(): void {
  const bar = el("bulkbar");
  if (selected.size === 0) { bar.hidden = true; return; }
  bar.hidden = false;
  el("selectedCount").textContent = `${selected.size}`;
  el<HTMLSelectElement>("bulkTarget").innerHTML = [
    `<option value="">选择目标领域…</option>`,
    `<option value="__new__">＋ 新建领域并分配</option>`,
    ...draft.map((d) => `<option value="${esc(d.name)}">移入：${esc(d.name)}</option>`),
    `<option value="__global__">移回全局（取消领域）</option>`,
  ].join("");
}

function updateButtons(): void {
  const save = el<HTMLButtonElement>("btnSave");
  save.disabled = !dirty;
  save.classList.toggle("is-dirty", dirty);
  el<HTMLButtonElement>("btnReset").disabled = !dirty;
  save.textContent = dirty ? "保存更改 •" : "保存更改";
}

function renderAll(): void {
  renderStats();
  renderFilters();
  renderRows();
  renderDomains();
  renderBulkbar();
  updateButtons();
  if (state) notice(state.warnings.length ? `注意：${state.warnings.join("；")}` : "");
}

function markDirty(structural: boolean): void {
  dirty = true;
  if (structural) renderAll();
  else { renderStats(); renderFilters(); renderRows(); renderBulkbar(); updateButtons(); }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function applyBulk(target: string): void {
  if (!state || selected.size === 0) return;
  if (!target) { toast("先选择目标领域", "error"); return; }

  let domainName = target;
  if (target === "__new__") {
    let n = 1;
    while (draft.some((d) => d.name === `new-domain-${n}`)) n += 1;
    domainName = `new-domain-${n}`;
    draft.push({ name: domainName, description: "", triggers: [], antiTriggers: [], skills: [] });
  }

  // Moving: strip selected skills from every domain first.
  for (const domain of draft) {
    domain.skills = domain.skills.filter((raw) => {
      const s = skillByRaw(raw);
      return !(s && selected.has(s.dirName));
    });
  }
  if (target !== "__global__") {
    const domain = draft.find((d) => d.name === domainName);
    if (domain) {
      for (const id of selected) {
        const s = state.skills.find((x) => x.dirName === id);
        if (s && s.valid && s.modelInvocable) domain.skills.push(s.name);
      }
    }
  }

  selected.clear();
  markDirty(true);
  toast(target === "__global__" ? "已移回全局（记得保存）" : `已分配到「${domainName}」（记得保存）`, "info");

  if (target === "__new__") {
    const card = document.querySelector<HTMLInputElement>(`.dc-name[data-index="${draft.length - 1}"]`);
    card?.focus();
    card?.select();
  }
}

function splitList(text: string): string[] {
  return text.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

async function loadState(): Promise<void> {
  const res = await fetch("/api/state");
  if (!res.ok) throw new Error(`加载状态失败：HTTP ${res.status}`);
  state = (await res.json()) as State;
  draft = clone(state.domains);
  dirty = false;
  selected.clear();
  renderAll();
}

async function save(): Promise<void> {
  if (!state || !dirty) return;
  const btn = el<HTMLButtonElement>("btnSave");
  btn.disabled = true;
  try {
    const res = await fetch("/api/domains", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: state.version, domains: draft }),
    });
    const data = (await res.json()) as SaveResponse;
    if (!res.ok) {
      toast([data.error ?? "保存失败", ...(data.errors ?? [])].join("\n"), "error");
      return;
    }
    if (data.state) {
      state = data.state;
      draft = clone(state.domains);
    }
    dirty = false;
    selected.clear();
    renderAll();
    toast(`已保存${data.backupPath ? "，旧文件已自动备份" : ""}`, "success");
    if (data.warnings?.length) notice(`写入完成，但有提示：${data.warnings.join("；")}`);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    updateButtons();
  }
}

async function applySettings(): Promise<void> {
  const skillsDir = el<HTMLInputElement>("cfgSkillsDir").value.trim();
  const mapPath = el<HTMLInputElement>("cfgMapPath").value.trim();
  try {
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillsDir, mapPath }),
    });
    const data = (await res.json()) as State & { error?: string };
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    state = data;
    draft = clone(state.domains);
    dirty = false;
    selected.clear();
    renderAll();
    hideModal("settingsModal");
    toast(`路径已保存并重新扫描：${state.configStorePath ?? "配置文件"}`, "success");
    if (state.configSource === "cli" || state.configSource === "env") {
      notice("本次运行由启动参数 / 环境变量指定了技能目录，优先级高于已保存的路径；下次启动仍以它们为准。");
    }
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), "error");
  }
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

function openDetail(id: string): void {
  if (!state) return;
  const s = state.skills.find((x) => x.dirName === id);
  if (!s) return;
  el("detailTitle").textContent = s.name || s.dirName;
  const fm = Object.entries(s.frontmatter).map(([k, v]) => `
    <tr><th>${esc(k)}</th><td>${esc(typeof v === "object" ? JSON.stringify(v) : String(v))}</td></tr>
  `).join("");
  const domain = effectiveDomain(s);
  const categoryLabel = skillCategory(s) === "user-command" ? "用户命令（/命令）" : (domain ?? "全局");
  el("detailBody").innerHTML = `
    <div class="detail-grid">
      <div><span class="dl">目录</span><strong>${esc(s.dirName)}</strong></div>
      <div><span class="dl">当前分类</span><strong>${esc(categoryLabel)}</strong></div>
      <div><span class="dl">文件数</span><strong>${esc(s.fileCount)}</strong></div>
      <div><span class="dl">总大小</span><strong>${esc(formatBytes(s.totalBytes))}</strong></div>
    </div>
    ${skillCategory(s) === "user-command" ? `<div class="detail-warn">此技能标记为 disable-model-invocation：只能由用户手动触发（如 /${esc(s.name)}），模型不会自动调用，也不能分配到领域。它不在 skilljack 的 catalog 里，但仍可被 load-skill 显式加载。</div>` : ""}
    ${s.issue ? `<div class="detail-warn">${esc(s.issue)}</div>` : ""}
    <div class="detail-path"><span class="dl">SKILL.md</span><code>${esc(s.skillPath || "—")}</code></div>
    ${s.topDirs.length ? `<div class="detail-path"><span class="dl">子目录</span><code>${esc(s.topDirs.join(" · "))}</code></div>` : ""}
    ${frontmatterTags(s).length ? `<div class="detail-warn">此技能的 frontmatter 声明了 domain: ${esc(frontmatterTags(s).join(", "))}。即使从映射中移除，服务端仍会按该字段归域；要彻底移回全局，请修改 SKILL.md。</div>` : ""}
    <h4>frontmatter</h4>
    <table class="kv"><tbody>${fm || `<tr><td colspan="2" class="muted">无</td></tr>`}</tbody></table>
    <h4>SKILL.md 全文</h4>
    <pre class="md">${esc(s.content || "（不可读）")}</pre>
  `;
  showModal("detailModal");
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

el<HTMLInputElement>("search").addEventListener("input", (e) => {
  searchQuery = (e.target as HTMLInputElement).value;
  renderRows();
});

el<HTMLSelectElement>("filterDomain").addEventListener("change", (e) => {
  filterValue = (e.target as HTMLSelectElement).value;
  renderRows();
});

el("skillRows").addEventListener("change", (e) => {
  const target = e.target as HTMLInputElement;
  if (!target.classList.contains("row-check")) return;
  const row = target.closest("tr");
  const id = row?.dataset.id;
  if (!id) return;
  if (target.checked) selected.add(id); else selected.delete(id);
  renderBulkbar();
  const all = el<HTMLInputElement>("selectAll");
  const assignableVisible = visibleSkills().filter((s) => s.valid && !s.isLink && s.modelInvocable);
  all.checked = assignableVisible.length > 0 && assignableVisible.every((s) => selected.has(s.dirName));
});

el<HTMLInputElement>("selectAll").addEventListener("change", (e) => {
  const checked = (e.target as HTMLInputElement).checked;
  for (const s of visibleSkills()) {
    if (!s.valid || s.isLink || !s.modelInvocable) continue;
    if (checked) selected.add(s.dirName); else selected.delete(s.dirName);
  }
  renderRows();
  renderBulkbar();
});

el("btnInvert").addEventListener("click", () => {
  for (const s of visibleSkills()) {
    if (!s.valid || s.isLink || !s.modelInvocable) continue;
    if (selected.has(s.dirName)) selected.delete(s.dirName); else selected.add(s.dirName);
  }
  renderRows();
  renderBulkbar();
});

el("btnClearSel").addEventListener("click", () => {
  selected.clear();
  renderRows();
  renderBulkbar();
});

el("btnApply").addEventListener("click", () => applyBulk(el<HTMLSelectElement>("bulkTarget").value));

el("skillRows").addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".btn-detail");
  if (btn?.dataset.id) openDetail(btn.dataset.id);
});

el("btnAddDomain").addEventListener("click", () => {
  let n = 1;
  while (draft.some((d) => d.name === `new-domain-${n}`)) n += 1;
  draft.push({ name: `new-domain-${n}`, description: "", triggers: [], antiTriggers: [], skills: [] });
  markDirty(true);
  const input = document.querySelector<HTMLInputElement>(`.dc-name[data-index="${draft.length - 1}"]`);
  input?.focus();
  input?.select();
});

el("domainList").addEventListener("input", (e) => {
  const target = e.target as HTMLInputElement;
  const index = Number(target.dataset.index);
  const domain = draft[index];
  if (!domain || Number.isNaN(index)) return;
  if (target.classList.contains("dc-name")) domain.name = target.value.trim() || domain.name;
  else if (target.classList.contains("dc-desc")) domain.description = target.value;
  else if (target.classList.contains("dc-triggers")) domain.triggers = splitList(target.value);
  else if (target.classList.contains("dc-anti")) domain.antiTriggers = splitList(target.value);
  else return;
  markDirty(false);
});

el("domainList").addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const del = target.closest<HTMLButtonElement>(".dc-del");
  if (del) {
    const i = Number(del.dataset.index);
    const name = draft[i]?.name;
    if (name && !window.confirm(`删除领域「${name}」？其成员将移回全局。\n（若成员还在 SKILL.md frontmatter 里写了 domain，需另行修改文件。）`)) return;
    draft.splice(i, 1);
    markDirty(true);
    return;
  }
  const chip = target.closest<HTMLButtonElement>(".chip-x");
  if (chip) {
    const i = Number(chip.dataset.index);
    const raw = chip.dataset.raw ?? "";
    if (draft[i]) draft[i].skills = draft[i].skills.filter((x) => x !== raw);
    markDirty(true);
  }
});

el("btnSave").addEventListener("click", () => { void save(); });
el("btnReset").addEventListener("click", () => {
  if (dirty && !window.confirm("放弃所有未保存的改动？")) return;
  void loadState().then(() => toast("已重置为已保存状态", "info")).catch((e) => toast(String(e), "error"));
});

el("btnSettings").addEventListener("click", () => {
  if (!state) return;
  el<HTMLInputElement>("cfgSkillsDir").value = state.skillsDir;
  el<HTMLInputElement>("cfgMapPath").value = state.mapPath;
  el("cfgStorePath").textContent = state.configStorePath ?? "~/.skilljack/config.json";
  showModal("settingsModal");
});
el("btnCancelSettings").addEventListener("click", () => hideModal("settingsModal"));
el("btnApplySettings").addEventListener("click", () => {
  if (dirty && !window.confirm("有未保存的改动，切换路径会丢弃。继续？")) return;
  void applySettings();
});

document.querySelectorAll<HTMLElement>("[data-close]").forEach((node) => {
  node.addEventListener("click", () => hideModal(node.dataset.close ?? ""));
});
document.querySelectorAll<HTMLElement>(".modal-backdrop").forEach((node) => {
  node.addEventListener("click", (e) => { if (e.target === node) node.hidden = true; });
});

window.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); void save(); return; }
  if (mod && e.key.toLowerCase() === "f") { e.preventDefault(); el<HTMLInputElement>("search").focus(); return; }
  if (e.key === "Escape") document.querySelectorAll<HTMLElement>(".modal-backdrop").forEach((n) => { n.hidden = true; });
});

window.addEventListener("beforeunload", (e) => { if (dirty) e.preventDefault(); });

// ---------------------------------------------------------------------------
// Theme — dark by default (matches the compact dashboard style); the toggle
// persists the choice in localStorage. The <head> inline script applies it
// before first paint, so there is no light flash on reload.
// ---------------------------------------------------------------------------

const THEME_KEY = "skilljack-admin-theme";
function applyTheme(theme: "dark" | "light"): void {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode */ }
}
el("btnTheme").addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

void loadState().catch((error: unknown) => {
  toast(error instanceof Error ? error.message : String(error), "error");
  el("emptyState").hidden = false;
  el("emptyState").textContent = "无法加载状态。确认服务已启动，并检查右上角的路径设置。";
});
