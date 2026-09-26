import path from "node:path";

export const SCHEMA_VERSION = 1;
export const SUPPORTED_SOURCE_SCHEMA_VERSIONS = [1];

export const MAX_WORKERS = 4;
export const MAX_RETRIES = 2;
export const REQUEST_TIMEOUT_SECONDS = 10;
export const RATE_LIMIT_SAFETY_MARGIN = 50;

export const VERSION_STRATEGIES = ["release", "tag", "commit"] as const;
export const RUNTIME_PLATFORMS = ["windows", "macos", "linux", "android", "ios"] as const;
export const GAME_PLATFORMS = [
  "SWITCH",
  "PS2",
  "PS",
  "PC",
  "N64",
  "GBA",
  "XBOX",
  "XBOX360",
  "NGC",
  "PSP",
  "WII",
  "N3DS",
  "NDS",
] as const;

export const STATUS_OK = "ok";
export const STATUS_UNAVAILABLE = "unavailable";
export const STATUS_ERROR = "error";

export const MAX_TITLE_LENGTH = 120;
export const MAX_DESCRIPTION_LENGTH = 2000;
export const MAX_GENRES_LENGTH = 120;

export const GAME_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const REPO_ROOT = path.resolve(import.meta.dirname, "..");
export const SOURCES_PATH = path.join(REPO_ROOT, "sources", "sources.json");
export const CATALOG_DIR = path.join(REPO_ROOT, "catalog");
export const GAMES_PATH = path.join(CATALOG_DIR, "games.json");
export const MANIFEST_PATH = path.join(CATALOG_DIR, "games.manifest.json");
export const STATE_DIR = path.join(REPO_ROOT, "state");
export const LAST_KNOWN_PATH = path.join(STATE_DIR, "last-known.json");
export const LAST_RUN_PATH = path.join(STATE_DIR, "last-run.json");
