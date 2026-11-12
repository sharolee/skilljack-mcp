#!/usr/bin/env node
/**
 * Domain admin console — standalone HTTP server (fork addition).
 *
 *   npm run domains-ui                          # build the TS front end, then serve
 *   npm run domains-ui -- --skills-dir=<path> --domain-map=<path> --port=5178
 *
 * This is a LOCAL maintenance tool. It binds 127.0.0.1 by default, serves a
 * single page, and only ever writes to the configured domain-map file (after
 * validation, with a timestamped backup and an atomic rename).
 *
 * Path resolution is configuration-driven; nothing machine-specific is baked
 * in. Priority: CLI flag > environment variable > project defaults.
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeState,
  validateDomainMap,
  writeDomainMap,
  type AdminConfig,
} from "./core.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const WEB_DIR = path.join(HERE, "web");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.slice(2).find((a) => a.startsWith(prefix));
  return arg === undefined ? undefined : arg.slice(prefix.length).trim();
}

function firstPath(value: string | undefined): string {
  if (!value) return "";
  return value.split(",").map((p) => p.trim()).filter(Boolean)[0] ?? "";
}

/** Upstream skilljack stores configured directories in ~/.skilljack/config.json. */
function skillsDirFromSkilljackConfig(): string {
  const file = path.join(os.homedir(), ".skilljack", "config.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as { skillDirectories?: unknown };
    if (!Array.isArray(parsed.skillDirectories)) return "";
    const first = parsed.skillDirectories.find(
      (p): p is string => typeof p === "string" && !p.startsWith("http") && !p.includes("github.com")
    );
    return first ? path.resolve(first) : "";
  } catch {
    return "";
  }
}

function inferMapPath(): string {
  const explicit = flag("domain-map") ?? process.env.SKILLJACK_DOMAIN_MAP;
  if (explicit && !["off", "0", "false", "none"].includes(explicit.toLowerCase())) {
    return path.resolve(explicit);
  }
  return path.join(REPO_ROOT, "domains.json");
}

const inferredSkillsDir =
  firstPath(flag("skills-dir") ?? process.env.SKILLS_DIR) || skillsDirFromSkilljackConfig();
// An empty value means "not configured". Never resolve("") — that would
// silently turn into the process working directory.
const config: AdminConfig = {
  skillsDir: inferredSkillsDir ? path.resolve(inferredSkillsDir) : "",
  mapPath: inferMapPath(),
};

const HOST = flag("host") ?? process.env.SKILLJACK_ADMIN_HOST ?? "127.0.0.1";
const PORT = Number(flag("port") ?? process.env.SKILLJACK_ADMIN_PORT ?? 5178);

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 1_000_000) throw new Error("请求体过大（上限 1 MB）");
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  if (!text.trim()) throw new Error("请求体为空");
  return JSON.parse(text) as unknown;
}

const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
};

function serveStatic(res: http.ServerResponse, urlPath: string): void {
  const entry = STATIC[urlPath];
  if (!entry) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }
  const file = path.join(WEB_DIR, entry.file);
  if (!fs.existsSync(file)) {
    sendJson(res, 503, {
      error:
        entry.file === "app.js"
          ? "前端尚未构建。请先运行 npm run build:admin，或直接用 npm run domains-ui 启动。"
          : `缺少静态文件 ${entry.file}`,
    });
    return;
  }
  const content = fs.readFileSync(file);
  res.writeHead(200, {
    "Content-Type": entry.type,
    "Content-Length": content.length,
    "Cache-Control": "no-store",
  });
  res.end(content);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const route = url.pathname;
  const method = req.method ?? "GET";

  if (route === "/api/state" && method === "GET") {
    sendJson(res, 200, computeState(config));
    return;
  }

  if (route === "/api/config" && method === "POST") {
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    if (typeof body.skillsDir === "string") {
      const value = body.skillsDir.trim();
      config.skillsDir = value ? path.resolve(value) : "";
    }
    if (typeof body.mapPath === "string" && body.mapPath.trim()) config.mapPath = path.resolve(body.mapPath.trim());
    sendJson(res, 200, computeState(config));
    return;
  }

  if (route === "/api/domains" && method === "PUT") {
    const body = await readJsonBody(req);
    const state = computeState(config);
    const prefix = state.skillsDir ? path.basename(state.skillsDir) : "";
    const result = validateDomainMap(body, state.skills, prefix);
    if (result.errors.length > 0) {
      sendJson(res, 400, { error: "领域映射校验失败", errors: result.errors, warnings: result.warnings });
      return;
    }
    if (!config.mapPath) {
      sendJson(res, 400, { error: "未配置领域映射路径" });
      return;
    }
    const { backupPath } = writeDomainMap(config.mapPath, result.map);
    sendJson(res, 200, { ok: true, backupPath, warnings: result.warnings, state: computeState(config) });
    return;
  }

  if (route === "/api/health" && method === "GET") {
    sendJson(res, 200, { ok: true, host: HOST, port: PORT });
    return;
  }

  if (method === "GET" && !route.startsWith("/api/")) {
    serveStatic(res, route);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[admin] ${req.method} ${req.url}: ${message}`);
    if (!res.headersSent) sendJson(res, 500, { error: message });
    else res.end();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Skilljack 领域管理控制台`);
  console.log(`  ─────────────────────────────────────────────`);
  console.log(`  地址        http://${HOST}:${PORT}`);
  console.log(`  技能库      ${config.skillsDir || "(未配置 — 可在界面右上角设置)"}`);
  console.log(`  领域映射    ${config.mapPath}`);
  console.log(`  ─────────────────────────────────────────────`);
  console.log(`  仅监听本机；写回前自动校验 + 备份。Ctrl+C 退出。\n`);
});
