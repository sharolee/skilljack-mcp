/**
 * Listing-only resource filter (fork addition).
 *
 * A skill that ships a large runtime asset library (a design kit, a pile of
 * images, fonts or archives) makes `resources/list` and the SEP-2640
 * `skills/list` manifests enormous. `design-taste-frontend`, for example,
 * carries 1,617 supporting files — one skill accounts for 93% of all the
 * `skill://` resources a typical library exposes.
 *
 * This filter removes those files from **automatic listings** only:
 *   - `resources/list` (the flat resource list a client auto-enumerates)
 *   - `skills/list` / `skills/get` manifests (the SEP-2640 entry resources)
 *   - `skill-resource` with an empty path (the "what files exist" listing)
 *
 * It deliberately does NOT block explicit, on-demand access:
 *   - `resources/read` of a filtered URI still works
 *   - `resources/directory/read` still browses every directory
 *   - `skill-resource` with an explicit path still reads any allowed file
 *
 * That keeps the "progressive disclosure" contract intact: you pay for a
 * heavy asset only when a task actually needs it, and the SKILL.md files can
 * keep referring to `assets/...` paths as they always have.
 *
 * Configuration (CLI flag > environment variable > default). Both CLI forms
 * are single tokens so `parseCLIArgs` does not mistake them for directories:
 *   --resource-filter=off       SKILLJACK_RESOURCE_FILTER=off
 *       Disable the filter entirely (upstream behaviour: list every file).
 *   --exclude-dirs=a,b          SKILLJACK_EXCLUDE_DIRS=a,b
 *       Directory names to drop from listings at any depth. Replaces default.
 *   --exclude-extensions=.png   SKILLJACK_EXCLUDE_EXTENSIONS=.png,.svg
 *       File extensions to drop from listings. Replaces default.
 *
 * An empty value means "do not filter this dimension", so
 * `SKILLJACK_EXCLUDE_DIRS=` keeps directories while still filtering extensions.
 */

import * as path from "node:path";

/** Directory names removed from automatic listings by default. */
export const DEFAULT_EXCLUDED_DIRS = ["assets"] as const;

/**
 * Extensions removed from automatic listings by default. Text / source
 * formats (.md, .json, .csv, .py, .mjs, .html, .css, .txt, .yaml) are kept
 * because they hold instructions and data the skills actually execute.
 */
export const DEFAULT_EXCLUDED_EXTENSIONS = [
  // images (SVG is text but is a design asset in practice)
  ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico",
  ".bmp", ".tif", ".tiff", ".psd", ".ai", ".sketch", ".fig",
  // documents and archives
  ".pdf", ".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar",
  // fonts
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  // audio and video
  ".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4a",
  ".mp4", ".webm", ".mov", ".avi", ".mkv",
  // compiled / binary
  ".exe", ".dll", ".so", ".dylib", ".bin", ".o", ".a", ".obj", ".lib",
  ".class", ".jar", ".pyc", ".pyo", ".node", ".wasm", ".pdb",
] as const;

export interface ResourceFilter {
  /** false = list every file, exactly like upstream skilljack. */
  enabled: boolean;
  /** Lower-cased directory names. */
  dirs: ReadonlySet<string>;
  /** Lower-cased extensions, always with a leading dot. */
  extensions: ReadonlySet<string>;
}

function option(flag: string, envVar: string): string | undefined {
  const prefix = `${flag}=`;
  const arg = process.argv.slice(2).find((a) => a.startsWith(prefix));
  return arg === undefined ? process.env[envVar] : arg.slice(prefix.length);
}

function parseList(raw: string | undefined, fallback: readonly string[]): string[] {
  if (raw === undefined) return [...fallback];
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
}

function normalizeExt(ext: string): string {
  const lower = ext.toLowerCase();
  return lower.startsWith(".") ? lower : `.${lower}`;
}

/** Resolve the active filter from CLI flags, env vars, then defaults. */
export function getResourceFilter(): ResourceFilter {
  const rawEnabled = option("--resource-filter", "SKILLJACK_RESOURCE_FILTER");
  // Consistent with the other two knobs: an explicitly empty value disables
  // filtering. An undefined value keeps the fork default (on).
  const enabled =
    rawEnabled === undefined
      ? true
      : rawEnabled.trim() === ""
        ? false
        : !["off", "0", "false", "no", "none"].includes(rawEnabled.trim().toLowerCase());

  const dirs = new Set(parseList(option("--exclude-dirs", "SKILLJACK_EXCLUDE_DIRS"), DEFAULT_EXCLUDED_DIRS));
  const extensions = new Set(
    parseList(
      option("--exclude-extensions", "SKILLJACK_EXCLUDE_EXTENSIONS"),
      DEFAULT_EXCLUDED_EXTENSIONS
    ).map(normalizeExt)
  );

  return { enabled, dirs, extensions };
}

/** Whether a directory with this name should be skipped while listing. */
export function isExcludedDirName(name: string, filter: ResourceFilter = getResourceFilter()): boolean {
  return filter.enabled && filter.dirs.has(name.toLowerCase());
}

/**
 * Whether a file should be skipped while listing, based on its extension.
 * Parent directories are handled separately by the recursive walk, so an
 * explicit read that starts inside `assets/` is never affected by this.
 */
export function isExcludedFilePath(
  relativePath: string,
  filter: ResourceFilter = getResourceFilter()
): boolean {
  if (!filter.enabled) return false;
  const normalized = relativePath.replace(/\\/g, "/");
  const leaf = normalized.slice(normalized.lastIndexOf("/") + 1);
  const ext = path.extname(leaf).toLowerCase();
  return ext.length > 0 && filter.extensions.has(ext);
}

/** One-line summary for stderr at startup, so the active policy is observable. */
export function describeResourceFilter(filter: ResourceFilter = getResourceFilter()): string {
  if (!filter.enabled) return "resource filter: OFF (all files listed)";
  return (
    `resource filter: ON — excluded dirs: ${[...filter.dirs].join(", ") || "(none)"}; ` +
    `excluded extensions: ${filter.extensions.size} ` +
    `(e.g. ${[...filter.extensions].slice(0, 6).join(" ")}) — ` +
    `listings stay lean; explicit reads remain available`
  );
}
