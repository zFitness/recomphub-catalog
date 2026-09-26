import {
  GAME_PLATFORMS,
  RUNTIME_PLATFORMS,
  VERSION_STRATEGIES,
} from "./constants.ts";

export type VersionStrategy = (typeof VERSION_STRATEGIES)[number];
export type RuntimePlatform = (typeof RUNTIME_PLATFORMS)[number];
export type GamePlatform = (typeof GAME_PLATFORMS)[number];
export type SourceStatus = "ok" | "unavailable" | "error";

export interface GitHubRef {
  owner: string;
  repository: string;
  branch?: string | null;
}

export interface SourceGame {
  gameId: string;
  title: string;
  titleCn?: string | null;
  platform: GamePlatform;
  runtimePlatforms: RuntimePlatform[];
  genres?: string | null;
  description?: string | null;
  projectUrl?: string | null;
  coverUrl?: string | null;
  github: GitHubRef;
  versionStrategy: VersionStrategy;
  fallback?: VersionStrategy[] | null;
  tagPattern?: string | null;
  enabled: boolean;
}

export interface SourcesDocument {
  schemaVersion: number;
  games: SourceGame[];
}

export interface CatalogSource {
  owner: string;
  repository: string;
  url: string;
  version?: string | null;
  versionType?: string | null;
  versionUrl?: string | null;
  revision?: string | null;
  publishedAt?: string | null;
  observedAt?: string | null;
  status?: SourceStatus;
  [key: string]: unknown;
}

export interface CatalogEntry {
  gameId: string;
  title: string;
  titleCn: string | null;
  platform: string;
  runtimePlatforms: string[];
  genres: string | null;
  description: string | null;
  projectUrl: string;
  coverUrl: string | null;
  source: CatalogSource;
}

export interface GamesDocument {
  schemaVersion: number;
  games: CatalogEntry[];
}

export interface Manifest {
  schemaVersion: number;
  catalogRevision: string;
  contentSha256: string;
  generatedAt: string;
  gameCount: number;
  dataUrl: string;
}

export interface LastKnownSource {
  version: string | null;
  versionType: string | null;
  versionUrl: string | null;
  revision: string | null;
  publishedAt: string | null;
  observedAt: string | null;
  status: SourceStatus | null;
}

export type LastKnown = Record<string, LastKnownSource>;

export interface RunReport {
  startedAt: string;
  finishedAt: string;
  totalSources: number;
  enabledSources: number;
  disabledSources: number;
  success: number;
  failed: number;
  skipped: number;
  requests: number | null;
  rateLimitRemaining: number | null;
  rateLimited: boolean;
  fatal: string[];
  gameCount: number;
  contentSha256: string;
}

export interface CatalogResult {
  data: Buffer;
  manifest: Manifest;
  lastKnown: LastKnown;
  report: RunReport;
  fatal: string[];
}
