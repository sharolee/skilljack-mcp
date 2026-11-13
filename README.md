# Skilljack MCP — large-library fork

[English](./README.md) · [简体中文](./README-ZH.md)

An MCP server that jacks [Agent Skills](https://agentskills.io) directly into your LLM's brain.

> **This repository is a fork of [`olaservo/skilljack-mcp`](https://github.com/olaservo/skilljack-mcp) (v0.15.2, MIT).** Upstream behaviour is preserved. Three opt-in additions make it practical for libraries with 100+ skills: a **listing-only resource filter**, **domain-based on-demand catalog routing**, and a **local web console** for maintaining the domain map. All paths below are placeholders such as `<SKILLS_DIR>` and `<REPO_ROOT>` — nothing in this document is tied to a particular machine, client, or skill set.

> **Tool search / deferred tools.** By default, skilljack delivers its skill catalog via MCP **server instructions**, which arrive in the `initialize` handshake and are visible to the model even when **tool search / deferred tool loading** is enabled (the default on modern Claude Code) — so automatic skill activation works out of the box. The legacy `--catalog=tool-description` mode (not recommended — see [Catalog channel](#usage) below) delivers the catalog through the `load-skill` tool description instead, but tool-search clients defer tool descriptions out of context, so that mode needs `ENABLE_TOOL_SEARCH=false` to auto-activate.

## About this fork

Upstream skilljack is excellent for a modest skill library, but two things grow linearly (or worse) with its size:

| Problem | Where it shows up | Fork addition |
| --- | --- | --- |
| A skill that ships thousands of design assets / binaries floods `resources/list` and the SEP-2640 `skills/list` manifests, and can breach the per-skill 512-file / 16 MiB interop limits. | Context is spent before any work starts | [Listing-only resource filter](#fork-listing-only-resource-filter): hide heavy files from **automatic listings** only; explicit reads still work |
| The flat `<available_skills>` catalog puts every skill in `instructions` on every connection (~574 B ≈ 143 tokens each, so 100+ skills cost 14k+ tokens up front). | Every connection, even for unrelated tasks | [Domain routing](#fork-domain-routing-on-demand-skill-discovery): main catalog lists global skills + a compact domain index; the model expands one domain on demand |
| Tagging 100+ skills by hand-editing JSON is error-prone and hard to review. | Maintenance | [Domain admin console](#fork-domain-admin-console-web-ui): search, batch assign, validate, preview catalog cost, back up |
| Hiding domain skills also hides the fact that they exist, so the model never thinks to look for one — every task needs an explicit reminder. | Every task | [Discovery preflight](#fork-domain-routing-on-demand-skill-discovery): a contract at the top of `instructions` plus server-side task → domain scoring |

The resulting disclosure chain has five steps — the model pays for each layer only when it needs it:

```
initialize instructions        →  <skill_preflight> contract + global skills + <skill_domains> index
find-skills-for-task(task)     →  server scores the task → best domain's <available_skills> entries
find-skills-for-task(domain)   →  (optional) a second, explicitly chosen domain
load-skill("<name>")           →  the full SKILL.md (upstream behaviour, unchanged)
resources/read, skill-resource <path>  →  one supporting file: script, style, asset
```

**Compatibility:** both server-side additions are reversible. The filter is on by default but `--resource-filter=off` restores upstream listing behaviour; routing activates only when a `domains.json` is configured and `--domain-map=off` returns to a flat catalog. Without a map, the catalog is byte-for-byte upstream's.

### Quick start (fork)

```bash
cd <REPO_ROOT>
npm install
npm run build

# Recommended for a large, heterogeneous skill library:
node dist/index.js \
  --list-mode=whitelist \
  --domain-map=<REPO_ROOT>/domains.json \
  <SKILLS_DIR>
```

A typical stdio MCP client entry (replace the placeholders):

```json
{
  "mcpServers": {
    "skilljack": {
      "type": "stdio",
      "command": "node",
      "args": [
        "<REPO_ROOT>/dist/index.js",
        "--list-mode=whitelist",
        "--domain-map=<REPO_ROOT>/domains.json",
        "<SKILLS_DIR>"
      ]
    }
  }
}
```

Use the `=<value>` form for every fork flag — a bare `--domain-map ./x.json` would make `./x.json` look like a skill directory. If a configuration manager distributes MCP entries to several clients, change the entry through that manager so a later sync does not overwrite it.

## Installation

```bash
npm install -g @skilljack/mcp
```

Or run directly with npx:

```bash
npx @skilljack/mcp /path/to/skills
```

### From Source

```bash
git clone https://github.com/olaservo/skilljack-mcp.git
cd skilljack-mcp
npm install
npm run build
node dist/index.js /path/to/skills
```

## Usage

```bash
# Single directory
skilljack-mcp /path/to/skills

# Multiple directories
skilljack-mcp /path/to/skills /path/to/more/skills

# GitHub repository (allowlisted via GITHUB_ALLOWED_ORGS / _USERS)
GITHUB_ALLOWED_ORGS=acme skilljack-mcp github.com/acme/skills

# Well-known publisher (allowlisted via WELL_KNOWN_ALLOWED_ORIGINS).
# Each entry's SHA-256 digest is verified against the published index.
# Every fetched URL — the index, each artifact, and any redirect target — must
# match an allowlisted origin, so if a publisher serves artifacts from a
# separate CDN origin, add that origin to the list too (comma-separated).
WELL_KNOWN_ALLOWED_ORIGINS=https://example.com \
  skilljack-mcp https://example.com/.well-known/agent-skills/

# Using environment variable
SKILLS_DIR=/path/to/skills skilljack-mcp

# Static mode (no file watching)
skilljack-mcp --static /path/to/skills

# Serve over HTTP instead of stdio (stateless Streamable HTTP on POST /mcp)
skilljack-mcp --http=3000 /path/to/skills
# or: SKILLJACK_HTTP_PORT=3000 skilljack-mcp /path/to/skills
```

**Transports:** stdio (default) or stateless HTTP (`--http[=port]`, default `3000`, or `SKILLJACK_HTTP_PORT`). HTTP serves the core skill surface (`load-skill`, `skill-resource`, `skill://` resources, `skills/list` / `skills/get`, and the `/skill` and per-skill prompts) at `POST /mcp`. Use the `--http=<port>` form: `--http 3000` treats `3000` as a skill directory. The HTTP server listens on all interfaces and has no authentication. Both transports use the MCP SDK's era-aware entry points, so a client negotiating MCP 2026-07-28 and a 2025-era client are served from the same server definition. Discovery-on-change works the same as stdio — file watchers and remote-source polling keep the skill state fresh, and every request (including each new client's `initialize`) reads it. Because the transport is stateless it does not *push* `listChanged`/`resources/updated` notifications: already-connected clients see changes on their next request or reconnect. The deprecated MCP Apps config/display UI is off by default (see below).

**Skills extension (SEP-2640):** the server declares `io.modelcontextprotocol/skills` (with `directoryRead`) through the MCP TypeScript SDK's skills extension and implements `skills/list`, `skills/get` and `resources/directory/read`. Each entry carries the skill's verbatim frontmatter and a `{uri, digest, size}` manifest of `SKILL.md` and every supporting file, so a host can verify what it reads. Files are served one at a time via `resources/read` under `skill://<skill-path>/<file>`; on 2026-07-28 connections the `skills/list` and `skills/get` results also carry the `ttlMs` / `cacheScope` caching attributes the extension requires. Supporting files larger than `MAX_FILE_SIZE_MB` (default 1) are not served and therefore not listed. `skill://index.json` is still served for clients written against the pre-v1 index shape.

**Tools:** `--tools=<auto|always|never>` (or `SKILLJACK_TOOLS`) controls the `load-skill` and `skill-resource` tools. `auto` (default) offers them unless the client declares `io.modelcontextprotocol/skills` in its capabilities, as MCP Inspector and MCPJam do; such a host loads skills itself through `skills/list`, `skills/get` and `resources/read`, so the tools are disabled after `initialize`. The catalog in server instructions lists each skill's `skill://` URI for that path. Over stateless HTTP the initialize handshake and later requests hit different server instances, and a 2026-07-28 connection has no initialize handshake at all, so `auto` behaves as `always` in both cases; use `never` there if the host has the extension. With `--catalog=tool-description` the catalog lives in the tool description, so `auto` is ignored.

**Catalog channel:** `--catalog=<instructions|tool-description>` (or `SKILLJACK_CATALOG`) picks which single channel delivers the `<available_skills>` catalog — never both. `instructions` (default): server `instructions`, sent in the `initialize` handshake so it survives tool-search deferral; on stdio it is frozen at startup — skill changes need a restart (over HTTP, newly connecting clients always get a current catalog). `tool-description` is **not recommended** and is retained only as a legacy escape hatch (and as the control condition in the evals): the `load-skill` tool description is invisible to clients that defer MCP tool descriptions (e.g. Claude Code tool search, the modern default), so auto-activation silently breaks unless the client sets `ENABLE_TOOL_SEARCH=false`; and its one advantage — live catalog refresh via `tools/listChanged` — is a prompt-cache trap, because tool definitions sit at the top of the cached prompt prefix, so every refresh invalidates the entire cache (tools + system prompt + conversation history) and re-writes it at cache-write prices. Measured 2026-07-06 ([#78](https://github.com/olaservo/skilljack-mcp/issues/78)): it has no cost advantage over `instructions` in steady state either.

## Fork: listing-only resource filter

This fork adds a **listing-only** resource filter. Skills that ship a large
runtime asset library (design kits, images, fonts, archives) otherwise bloat
`resources/list` and the SEP-2640 `skills/list` manifests with thousands of
URIs, which pushes the skill catalog out of context and can breach the
per-skill interop limits (512 files / 16 MB).

**The filter affects listings only.** `resources/read`,
`resources/directory/read`, and `skill-resource <path>` still serve every
eligible file on demand, so a skill's `assets/...` references keep working —
the model pays for an asset only when a task actually needs it. A file hidden
from the listing can still be loaded by name: skill instructions (`SKILL.md`,
the `load-skill` result) carry the absolute `<location>` and explicit paths to
scripts/styles, and an agent can also browse via `resources/directory/read`.

### Two listing modes

`--list-mode` (env `SKILLJACK_LIST_MODE`) picks how the filter decides what to
include. Both modes are listing-only and share the "explicit reads still work"
guarantee.

**`blacklist` (default)** — list everything except excluded dirs and
extensions. Suits libraries where most files are instructions. Omitted by
default:

- directories named `assets/` (at any depth), and
- binary / design asset extensions (`.svg`, `.png`, `.jpg`, `.webp`, `.pdf`,
  `.zip`, fonts, media, compiled artefacts, …).

**`whitelist`** — list only allowed extensions from non-ignored directories.
Suits skills with many heterogeneous subdirectories (`scripts/`, `references/`,
`styling/`, `data/`, `templates/`, …): it keeps every text / source / data
format visible **regardless of directory name**, and hides binaries, unknown
formats, and runtime/test artifacts. Allowed by default:

- extensions: `.md`, `.mdx`, `.txt`, `.rst`, `.adoc`, `.json`, `.jsonc`,
  `.yaml`, `.yml`, `.toml`, `.csv`, `.tsv`, `.xml`, `.py`, `.js`, `.mjs`,
  `.cjs`, `.ts`, `.mts`, `.cts`, `.jsx`, `.tsx`, `.sh`, `.bash`, `.zsh`,
  `.ps1`, `.bat`, `.cmd`, `.html`, `.htm`, `.css`, `.scss`, `.sass`, `.less`,
  `.sql`, `.graphql`;
- ignored dirs (even if their files have allowed extensions): `assets`,
  `tests`, `test`, `__tests__`, `__pycache__`, `fixtures`, `node_modules`,
  `dist`, `build`, `out`, `target`, `coverage`, `.git`, `vendor`, `.venv`,
  `venv`, `site-packages`.

Files with no extension are hidden in whitelist mode (they cannot be
identified as safe text). `SKILL.md` itself is never listed in either mode —
it is delivered by `load-skill`.

Configuration (CLI flag > environment variable > default):

| CLI flag | Environment variable | Default |
| --- | --- | --- |
| `--resource-filter=off` | `SKILLJACK_RESOURCE_FILTER=off` | on |
| `--list-mode=whitelist` | `SKILLJACK_LIST_MODE=whitelist` | `blacklist` |
| `--exclude-dirs=assets,media` | `SKILLJACK_EXCLUDE_DIRS=assets,media` | `assets` (blacklist) |
| `--exclude-extensions=.png,.svg` | `SKILLJACK_EXCLUDE_EXTENSIONS=.png,.svg` | 56 binary types (blacklist) |
| `--allow-extensions=.md,.py` | `SKILLJACK_ALLOW_EXTENSIONS=.md,.py` | text/source/data formats (whitelist) |
| `--ignore-dirs=tests,assets` | `SKILLJACK_IGNORE_DIRS=tests,assets` | test/build/cache dirs (whitelist) |

Use the `=<value>` form: a bare `--exclude-dirs assets` would make `assets`
look like a skill directory. An empty value disables that dimension — e.g.
`SKILLJACK_ALLOW_EXTENSIONS=` allows no files at all in whitelist mode, while
`SKILLJACK_EXCLUDE_DIRS=` keeps every directory in blacklist mode. The active
policy is printed to stderr at startup.

## Fork: domain routing (on-demand skill discovery)

A flat `<available_skills>` catalog lists every skill in the server
`instructions` on every connection — roughly 574 B (~143 tokens) per skill. At
100+ skills that is 14k+ tokens spent before any work begins, growing linearly
with the library. This fork adds an **optional third discovery layer**: tag
skills with a domain, and only untagged ("global") skills plus a compact domain
index are put in the main catalog. The model expands one domain on demand via
the `find-skills-for-task` tool.

Progressive disclosure has a discoverability cost: a model that cannot see a
skill's name cannot judge whether "a skill is relevant", so a conditional
instruction like *"load a relevant skill first"* never fires. This fork closes
that gap with a **discovery preflight** — a short contract placed first in
`instructions` that makes one call mandatory at the start of any non-trivial
task, and moves the relevance judgement into the server:

```
Main catalog (instructions)   →  <skill_preflight> + global skills + <skill_domains> index
        │ any non-trivial task starts (unconditional)
        ▼
find-skills-for-task(task)    →  server scores triggers → best domain's <available_skills> entries
        ▼
load-skill("<name>")          →  full SKILL.md (unchanged)
```

`triggers` / `antiTriggers` are therefore **executable routing rules**, not just
advisory hints: CJK terms match as substrings (+3), ASCII terms at word
boundaries (+2), domain descriptions add weak evidence (+1), any
`antiTriggers` match vetoes the domain, and the runner-up must be within 70% of
the winner to be suggested. A `Task skill routing: …` line on stderr records
every decision so the word lists can be tuned over time.

**Routing is discovery-only.** It never removes a skill from the server's
skill map: `load-skill`, `skill-resource`, `resources/list`, the SEP-2640
`skills/list` / `skills/get` and `/skill` prompts still expose every skill. A
model that already knows a name loads it directly; a skills-aware host sees the
full list. Skills with **no domain are global** and appear in the main catalog
exactly as upstream, so the feature is opt-in and backward compatible.

### Domain map

Domains are declared in a JSON file (see [`domains.json`](./domains.json)):

```json
{
  "version": 1,
  "domains": [
    {
      "name": "design",
      "description": "UI/UX, visual design, design systems",
      "triggers": ["design", "UI", "frontend"],
      "antiTriggers": ["backend logic"],
      "skills": ["mobile-ui-kit", "design-system-kit"]
    }
  ]
}
```

`skills[]` accepts either the frontmatter name or the qualified `prefix__name`.
A skill can also tag itself in SKILL.md frontmatter with `domain: design` or
`domains: [design, test]` — useful when a skill travels between repositories.
Map entries take precedence; a skill listed in two domains goes to the first.
Unknown skill names are warned on stderr and ignored, so a stale map can never
hide a real skill.

Configuration (CLI flag > environment variable > `./domains.json` in cwd):

| CLI flag | Environment variable | Default |
| --- | --- | --- |
| `--domain-map=./domains.json` | `SKILLJACK_DOMAIN_MAP=./domains.json` | `./domains.json` if present |
| `--domain-map=off` | `SKILLJACK_DOMAIN_MAP=off` | routing disabled → flat catalog |

If the map is missing or invalid, routing **fails open**: every skill is listed
globally and a warning is printed to stderr. Disable it at any time with
`--domain-map=off` (flat upstream catalog) without removing any files. Use the
`=<value>` form — a bare `--domain-map ./x.json` would make `./x.json` look
like a skill directory. Domain routing applies to the default
`--catalog=instructions` channel; the legacy `--catalog=tool-description` mode
keeps its flat catalog.

The active policy (domains, skill counts, global count, map path) is printed to
stderr at startup, e.g. `domain routing: ON — 2 domain(s) [design=3, test=1],
N global skill(s); map: <path-to-domains.json>`.

### The `find-skills-for-task` tool

| Call | Returns |
| --- | --- |
| `find-skills-for-task({ "task": "make this table denser" })` | **Recommended first action.** `<task_routing>` with the best-matching domain, its score and matched triggers, followed by that domain's `<available_skills>` entries — one call, no guessing which domain to expand |
| `find-skills-for-task()` | `<domains>` directory: name, description, skill count and triggers for every domain |
| `find-skills-for-task({ "domain": "design" })` | That domain's `<available_skills>` entries (name / description / uri / location); then `load-skill` a chosen name |
| `find-skills-for-task({ "domain": "nope" })` | An error listing the valid domain names |

An explicit `domain` always wins over `task`; an empty `task` behaves like no
arguments. If no domain clears the scoring threshold, the tool returns the
domain directory and tells the model to continue with the global skills — so
passing a task is always safe (fail-open). Only the **winning** domain is
expanded; a close runner-up is named in `<also_relevant>` and can be fetched
with a second `domain` call, which keeps a single call to one domain's worth of
tokens.

Domain names are matched case-insensitively. The tool is read-only, idempotent, and registered **independently of `--tools`** (it is the discovery layer for clients *without* the skills extension, so `--tools=auto` must not disable it). Each call re-evaluates the live skill state, so skills added by the file watcher are visible without a restart. When routing is disabled the tool still exists and answers that all skills are global. Routing applies only to the default `--catalog=instructions` channel.

> **Rename:** earlier revisions of this fork called the tool `route-domain`. The name was changed because it did not mention skills. The old name is **not** registered as an alias — update saved prompts and client snippets, then restart the MCP client (the launch arguments themselves are unchanged).

## Fork: domain admin console (web UI)

`npm run domains-ui` starts a **standalone local web console** for browsing the
skill library and maintaining `domains.json` in bulk. It is TypeScript on both
ends (a Node `http` server plus a plain-DOM front end), adds no dependencies,
runs as a separate process from the MCP server, and binds `127.0.0.1` only.

```bash
npm run domains-ui
# or with explicit paths:
npm run domains-ui -- --skills-dir=<path-to-skills> --domain-map=<path-to-domains.json> --port=5178
```

Open `http://127.0.0.1:5178`. Path resolution order: CLI flags > `SKILLS_DIR` /
`SKILLJACK_DOMAIN_MAP` / `SKILLJACK_ADMIN_PORT` / `SKILLJACK_ADMIN_HOST` >
`~/.skilljack/config.json` > `./domains.json` in the repo root. Paths can also
be changed at runtime from the in-app Settings dialog (in-memory only; nothing
is written to a config file). The build step (`npm run build:admin`) runs
automatically on startup and is also available on its own.

What it does:

- **Compact dashboard layout** — five KPIs live in the sticky top bar instead of a separate card row; the hero KPI carries a domain-coverage bar, key figures are colour-accented, and both panels share a row height with internal scrolling. A top-bar toggle switches between the default dark theme and a light theme (persisted in `localStorage`).
- **Browse / search** every discovered skill — name, description, frontmatter,
  full `SKILL.md`, resource counts and absolute paths. Symlinks, missing
  `SKILL.md` and invalid frontmatter appear as flagged rows instead of silently
  disappearing.
- **Batch assign** — multi-select skills, then move them into a domain, into a
  new domain, or back to global. Assignment is a *move*: the skill is removed
  from its previous domain, matching the server's one-skill-one-domain rule.
- **Edit domains** — add/delete, edit `name`, `description`, `triggers`,
  `antiTriggers`, and remove individual members.
- **Preview cost** — live estimate of main-catalog bytes/tokens and the saving
  versus a flat catalog, reflecting unsaved edits.
- **Surface the frontmatter trap** — if a skill still declares `domain` in its
  SKILL.md, removing it from the map does not make it global. The UI flags that
  explicitly instead of letting you assume the move worked.

Writes are safe: `PUT /api/domains` validates first (rejecting duplicate domain
names, non-array `skills`, and multi-domain membership), then writes atomically
(`tmp` + `rename`) after creating a timestamped backup. The 5 most recent
backups are kept. Unknown skill names are warnings, not errors, so a portable
map may reference skills that are not installed on this machine. The skills
library itself is never written to.

The console scans the configured skills directory only. Bundled skills shipped
with the server live elsewhere and therefore do not appear in its list. See
[SKILLS-AND-DOMAINS.md](./SKILLS-AND-DOMAINS.md) for the underlying rules.

## Fork: configuration & development

All fork flags use the `--flag=<value>` form; CLI > environment variable > built-in default. An explicitly empty value disables that dimension (e.g. `SKILLJACK_EXCLUDE_DIRS=` keeps every directory in blacklist mode). The active filter and routing policies are printed to stderr at startup.

| Flag | Environment variable | Default | Purpose |
| --- | --- | --- | --- |
| `--resource-filter=off` | `SKILLJACK_RESOURCE_FILTER` | on | Restore upstream listing behaviour |
| `--list-mode=blacklist\|whitelist` | `SKILLJACK_LIST_MODE` | `blacklist` | How automatic listings decide inclusion |
| `--exclude-dirs=…` | `SKILLJACK_EXCLUDE_DIRS` | `assets` | Blacklist: directory names to hide |
| `--exclude-extensions=…` | `SKILLJACK_EXCLUDE_EXTENSIONS` | 56 binary types | Blacklist: extensions to hide |
| `--allow-extensions=…` | `SKILLJACK_ALLOW_EXTENSIONS` | text / source / data formats | Whitelist: extensions to list |
| `--ignore-dirs=…` | `SKILLJACK_IGNORE_DIRS` | test / build / cache dirs | Whitelist: directories to skip |
| `--domain-map=<path>\|off` | `SKILLJACK_DOMAIN_MAP` | `./domains.json` if present | Domain routing on / off |
| `--ui-tools=<on\|off>` | `SKILLJACK_UI_TOOLS` | `off` | Restore the deprecated upstream MCP Apps tools, UI prompts and `ui://` resources |

Upstream options (`--static`, `--http`, `--tools`, `--catalog`, `SKILLS_DIR`, …) are unchanged; the maintainer guide has a [complete configuration reference](./SKILLS-AND-DOMAINS.md).

### Repository layout (fork additions)

| Path | Role |
| --- | --- |
| `src/resource-filter.ts` | Filter policy, defaults, blacklist / whitelist predicates, startup description |
| `src/skill-tool.ts` | Applies the filter in `listSkillFiles()` only; splits the main catalog; emits `<skill_preflight>`; defines `find-skills-for-task` (task / domain / no-arg) and logs routing decisions to stderr |
| `src/domain-router.ts` | Reads `domains.json`, frontmatter fallback, name matching, warnings, fail-open, and pure `task → domain` scoring |
| `src/index.ts` | CLI flag documentation and stderr startup summary for both policies |
| `domains.json` | Portable domain map (edit it, or copy it to your own path) |
| `admin/core.ts` | Skill scanning, domain-map validation, atomic writes, backups, catalog-cost estimate |
| `admin/server.ts`, `admin/web/*` | Standalone TypeScript HTTP server + dependency-free DOM front end |
| `src/*.test.ts`, `admin/core.test.ts` | Vitest suites for filters, routing, catalog, tool calls and admin writes |
| `SKILLS-AND-DOMAINS.md` | Maintainer guide: adding skills, tagging domains, verifying, troubleshooting (Chinese) |

### Commands

| Command | What it does |
| --- | --- |
| `npm run build` | Build MCP Apps UI bundles and compile the server to `dist/` |
| `npm run build:admin` | Compile the admin console TypeScript |
| `npm run typecheck` | Type-check the server and the MCP Apps UI |
| `npm test` / `npm run test:watch` | Run the Vitest suite once / in watch mode |
| `npm run domains-ui` | Build and start the domain admin console |
| `npm run dev` | `tsx watch src/index.ts` |
| `npm run inspector` | Launch MCP Inspector against `dist/index.js` |

The tests lock down the invariants that make this fork safe to deploy: **listing-only** (a hidden asset is still readable by URI and executable from its disk path), **discovery-only** (routing never removes a skill from the skill map, `load-skill` / `resources/list` / `skills/list` still see everything), **fail-open** (missing or invalid map degrades to a flat catalog), **one skill → one domain** with unknown names warned not hidden, **stdio purity** (stdout carries JSON-RPC only, even with `env: {}`), and **safe admin writes** (validate → timestamped backup → atomic rename; the skill library is never written to).

## Deprecated: upstream MCP Apps config/display UI

Upstream shipped 11 `skill-config-*` / `skill-display-*` tools, the `/skills` and `/skill-config` prompts, and two `ui://` resources for hosts that render [MCP Apps](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/). In this fork that surface is **deprecated and not registered by default**: only MCP Apps-capable hosts can render it, the config it writes is overridden by the CLI directories passed to the server, and 11 unused tool descriptions otherwise occupy model context. The default tool surface is exactly `load-skill`, `skill-resource` and `find-skills-for-task`.

Pass `--ui-tools=on` (or `SKILLJACK_UI_TOOLS=on`) to restore the whole legacy surface at once. Tools, prompts and `ui://` resources are gated together, so no prompt can reference a missing tool; `--static` and `--http` still cannot serve it. Config-file *reading* (`~/.skilljack/config.json`) continues to work — only the in-chat editors are gone. Use the [fork admin console](#fork-domain-admin-console-web-ui) for domain maintenance instead.

The source files are kept and marked `@deprecated` so upstream merges stay straightforward; they are no longer part of the advertised capabilities, and nothing about them is written into server `instructions`, tool descriptions, prompts or `manifest.json`.

## Documentation

| Document | Language | Contents |
| --- | --- | --- |
| [README.md](./README.md) | English | This file: installation, usage, fork features, configuration and development |
| [README-ZH.md](./README-ZH.md) | 简体中文 | The Chinese counterpart of this README |
| [SKILLS-AND-DOMAINS.md](./SKILLS-AND-DOMAINS.md) | 简体中文 | Maintainer guide: adding skills, tagging and maintaining domains, the routing contract, visibility rules, verification and troubleshooting |
| [Upstream full reference](https://github.com/olaservo/skilljack-mcp/blob/main/skills/skilljack-docs/SKILL.md) | English | Tools, prompts, resources, configuration, architecture — loaded on demand by the bundled `skilljack-docs` skill |

For the upstream reference, just ask your assistant:

> "how do I use skilljack?" or "how does skilljack work behind the scenes?"

The server loads the bundled documentation skill on demand. For anything about **adding skills or maintaining domains in this fork**, start with `SKILLS-AND-DOMAINS.md` — it is intentionally environment-independent, so it can travel with the repository.

## Related

- [Agent Skills Specification](https://agentskills.io)
- [Skills Over MCP Interest Group repository](https://github.com/modelcontextprotocol/experimental-ext-skills)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Example MCP Clients](https://modelcontextprotocol.io/clients)

## Upstream & License

Based on [`olaservo/skilljack-mcp`](https://github.com/olaservo/skilljack-mcp) v0.15.2 by Ola Hungerford. Upstream is MIT-licensed; this fork keeps the same [LICENSE](./LICENSE). The fork additions (listing-only filter, domain routing, admin console) live in `src/`, `admin/` and `domains.json` and are designed to be toggled off individually, so the server can always fall back to upstream behaviour.
