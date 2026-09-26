import { createHash } from "node:crypto";

import {
  MAX_WORKERS,
  SCHEMA_VERSION,
  STATUS_ERROR,
  STATUS_OK,
} from "./constants.ts";
import { RateLimitError, SyncError } from "./errors.ts";
import { VersionInfo, resolveVersion, type GitHubApi } from "./github_client.ts";
import type {
  CatalogEntry,
  CatalogResult,
  GamesDocument,
  LastKnown,
  LastKnownSource,
  Manifest,
  RunReport,
  SourceGame,
  SourcesDocument,
} from "./types.ts";
import { dumpJson, nowIso } from "./util.ts";
import { validateCatalog, validateSources } from "./validation.ts";

export function versionFields(version: VersionInfo): Record<string, unknown> {
  return {
    version: version.version,
    versionType: version.versionType,
    versionUrl: version.versionUrl,
    revision: version.revision,
    publishedAt: version.publishedAt,
  };
}

export function buildEntry(
  source: SourceGame,
  version: VersionInfo,
  previous: LastKnownSource | null,
  observedAt: string,
): CatalogEntry {
  const github = source.github;
  const owner = github.owner;
  const repository = github.repository;

  const entry: CatalogEntry = {
    gameId: source.gameId,
    title: source.title,
    titleCn: source.titleCn ?? null,
    platform: source.platform,
    runtimePlatforms: [...source.runtimePlatforms],
    genres: source.genres ?? null,
    description: source.description ?? null,
    projectUrl: source.projectUrl || `https://github.com/${owner}/${repository}`,
    coverUrl: source.coverUrl ?? null,
    source: {
      owner,
      repository,
      url: `https://github.com/${owner}/${repository}`,
    },
  };

  if (version.status === STATUS_OK) {
    const unchanged = Boolean(
      previous &&
        previous.version === version.version &&
        previous.revision === version.revision &&
        previous.versionType === version.versionType,
    );
    Object.assign(entry.source, versionFields(version));
    entry.source.observedAt = unchanged && previous ? previous.observedAt : observedAt;
    entry.source.status = STATUS_OK;
  } else if (previous && previous.version) {
    for (const [key, value] of Object.entries(previous)) {
      if (key !== "status") {
        entry.source[key] = value;
      }
    }
    entry.source.status = version.status;
  } else {
    Object.assign(entry.source, versionFields(version));
    entry.source.observedAt = observedAt;
    entry.source.status = version.status;
  }

  return entry;
}

export function generateCatalog(
  entries: CatalogEntry[],
  generatedAt: string,
): { data: Buffer; manifest: Manifest } {
  const games = [...entries].sort((left, right) =>
    left.gameId < right.gameId ? -1 : left.gameId > right.gameId ? 1 : 0,
  );
  const document: GamesDocument = { schemaVersion: SCHEMA_VERSION, games };
  const text = dumpJson(document);
  const data = Buffer.from(text, "utf-8");
  const digest = createHash("sha256").update(data).digest("hex");
  const manifest: Manifest = {
    schemaVersion: SCHEMA_VERSION,
    catalogRevision: `sha256-${digest.slice(0, 16)}`,
    contentSha256: digest,
    generatedAt,
    gameCount: games.length,
    dataUrl: "games.json",
  };
  return { data, manifest };
}

export async function computeCatalog(
  sourcesDoc: unknown,
  client: GitHubApi,
  lastKnown: LastKnown,
  observedAt?: string,
  maxWorkers = MAX_WORKERS,
): Promise<CatalogResult> {
  const generatedAt = observedAt ?? nowIso();
  const errors = validateSources(sourcesDoc);
  if (errors.length > 0) {
    throw new SyncError(`sources.json is invalid:\n  - ${errors.join("\n  - ")}`);
  }

  const { games: allGames } = sourcesDoc as SourcesDocument;
  const enabled = allGames.filter((game) => game.enabled);
  const disabled = allGames.filter((game) => !game.enabled);

  const startedAt = generatedAt;
  const results: VersionInfo[] = enabled.map(
    () => new VersionInfo("", "", "", "", null, STATUS_ERROR),
  );
  let rateLimited = false;

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= enabled.length) {
        return;
      }
      const game = enabled[index]!;
      try {
        results[index] = await resolveVersion(game, client);
      } catch (error) {
        if (error instanceof RateLimitError) {
          rateLimited = true;
        }
        results[index] = new VersionInfo("", "", "", "", null, STATUS_ERROR);
      }
    }
  };
  const workerCount = Math.max(1, Math.min(maxWorkers, enabled.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const entries: CatalogEntry[] = [];
  const newLastKnown: LastKnown = {};
  const fatal: string[] = [];
  let success = 0;
  let failed = 0;

  enabled.forEach((game, index) => {
    const gameId = game.gameId;
    const version = results[index] ?? new VersionInfo("", "", "", "", null, STATUS_ERROR);
    const previous = lastKnown[gameId] ?? null;
    const hasPrevious = Boolean(previous && previous.version);

    if (version.status !== STATUS_OK && !hasPrevious) {
      fatal.push(gameId);
    }

    const entry = buildEntry(game, version, previous, generatedAt);
    entries.push(entry);
    newLastKnown[gameId] = {
      version: (entry.source.version as string | null) ?? null,
      versionType: (entry.source.versionType as string | null) ?? null,
      versionUrl: (entry.source.versionUrl as string | null) ?? null,
      revision: (entry.source.revision as string | null) ?? null,
      publishedAt: (entry.source.publishedAt as string | null) ?? null,
      observedAt: (entry.source.observedAt as string | null) ?? null,
      status: entry.source.status ?? null,
    };
    if (entry.source.status === STATUS_OK) {
      success += 1;
    } else {
      failed += 1;
    }
  });

  if (rateLimited) {
    fatal.push("__rate_limited__");
  }

  const { data, manifest } = generateCatalog(entries, generatedAt);
  const catalogErrors = validateCatalog(JSON.parse(data.toString("utf-8")));
  if (catalogErrors.length > 0) {
    throw new SyncError(`generated catalog is invalid:\n  - ${catalogErrors.join("\n  - ")}`);
  }

  const report: RunReport = {
    startedAt,
    finishedAt: nowIso(),
    totalSources: allGames.length,
    enabledSources: enabled.length,
    disabledSources: disabled.length,
    success,
    failed,
    skipped: disabled.length,
    requests: client.requests,
    rateLimitRemaining: client.rateLimitRemaining,
    rateLimited,
    fatal: [...fatal],
    gameCount: manifest.gameCount,
    contentSha256: manifest.contentSha256,
  };

  return { data, manifest, lastKnown: newLastKnown, report, fatal };
}
