# Skilljack MCP

An MCP server that jacks [Agent Skills](https://agentskills.io) directly into your LLM's brain.

> **Tool search / deferred tools.** By default, skilljack delivers its skill catalog via MCP **server instructions**, which arrive in the `initialize` handshake and are visible to the model even when **tool search / deferred tool loading** is enabled (the default on modern Claude Code) — so automatic skill activation works out of the box. The legacy `--catalog=tool-description` mode (not recommended — see [Catalog channel](#usage) below) delivers the catalog through the `load-skill` tool description instead, but tool-search clients defer tool descriptions out of context, so that mode needs `ENABLE_TOOL_SEARCH=false` to auto-activate.

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

**Transports:** stdio (default) or stateless HTTP (`--http[=port]`, default `3000`, or `SKILLJACK_HTTP_PORT`). HTTP serves the core skill surface (`load-skill`, `skill-resource`, `skill://` resources, `skills/list` / `skills/get`, and the `/skill` and per-skill prompts) at `POST /mcp`. Use the `--http=<port>` form: `--http 3000` treats `3000` as a skill directory. The HTTP server listens on all interfaces and has no authentication. Both transports use the MCP SDK's era-aware entry points, so a client negotiating MCP 2026-07-28 and a 2025-era client are served from the same server definition. Discovery-on-change works the same as stdio — file watchers and remote-source polling keep the skill state fresh, and every request (including each new client's `initialize`) reads it. Because the transport is stateless it does not *push* `listChanged`/`resources/updated` notifications: already-connected clients see changes on their next request or reconnect. The MCP-Apps configuration UI is stdio-only.

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
the `route-domain` tool.

```
Main catalog (instructions)   →  global skills + <skill_domains> index (names only)
        │ model sees a task matching a domain
        ▼
route-domain("design")        →  that domain's <available_skills> entries
        ▼
load-skill("<name>")          →  full SKILL.md (unchanged)
```

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
      "skills": ["design-mobile-apps", "design-taste-frontend"]
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
stderr at startup, e.g. `domain routing: ON — 2 domain(s) [design=5, test=1],
8 global skill(s); map: .../domains.json`.

## Configuration and Skills Display UI

This server comes along with a [MCP Apps](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/)-based UI for clients that support it.  Instead of fiddling with config files or environment variables, you can just configure your skills locations and skill visiblity directly in your chat window. Locations set in the UI are saved to `~/.skilljack/config.json` and take effect only when no directories are given on the command line or in `SKILLS_DIR`. The UI is not available with `--static` or `--http`.

(Screenshots below are from Claude Desktop in dark mode.)

![Skills Configuration UI](docs/images/skills-config-ui.png)

![Skill Display UI](docs/images/skill-display-ui.png)

## Documentation

For complete documentation, just ask your assistant:

> "how do I use skilljack?" or "how does skilljack work behind the scenes?"

This loads the [full reference](https://github.com/olaservo/skilljack-mcp/blob/main/skills/skilljack-docs/SKILL.md) including tools, prompts, resources, configuration options and environment variables, and architecture details.

For maintaining skills and domains in this fork — adding skills, tagging domains, and understanding the on-demand routing contract — see [SKILLS-AND-DOMAINS.md](./SKILLS-AND-DOMAINS.md).

## Related

- [Agent Skills Specification](https://agentskills.io)
- [Skills Over MCP Interest Group repository](https://github.com/modelcontextprotocol/experimental-ext-skills)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Example MCP Clients](https://modelcontextprotocol.io/clients)
