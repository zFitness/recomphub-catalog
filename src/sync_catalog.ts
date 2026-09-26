#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { computeCatalog } from "./catalog.ts";
import {
  GAMES_PATH,
  LAST_KNOWN_PATH,
  LAST_RUN_PATH,
  MANIFEST_PATH,
  SOURCES_PATH,
} from "./constants.ts";
import { SyncError } from "./errors.ts";
import { GitHubClient } from "./github_client.ts";
import type { LastKnown } from "./types.ts";
import { dumpJson, loadJson, writeText } from "./util.ts";
import { validateSources } from "./validation.ts";

export async function runSync(): Promise<number> {
  if (!existsSync(SOURCES_PATH)) {
    process.stderr.write(`sources file not found: ${SOURCES_PATH}\n`);
    return 1;
  }
  const sourcesDoc = loadJson(SOURCES_PATH);
  const lastKnown = (existsSync(LAST_KNOWN_PATH) ? loadJson(LAST_KNOWN_PATH) : {}) as LastKnown;
  const client = new GitHubClient({ token: process.env.GITHUB_TOKEN ?? null });

  let result;
  try {
    result = await computeCatalog(sourcesDoc, client, lastKnown);
  } catch (error) {
    if (error instanceof SyncError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }

  if (result.fatal.length > 0) {
    process.stderr.write("sync blocked; catalog was not published:\n");
    for (const gameId of result.fatal) {
      process.stderr.write(`  - ${gameId}\n`);
    }
    writeText(LAST_RUN_PATH, dumpJson(result.report));
    return 1;
  }

  const existing = existsSync(GAMES_PATH) ? readFileSync(GAMES_PATH) : null;
  const contentChanged = existing === null || !existing.equals(result.data);

  if (contentChanged || !existsSync(MANIFEST_PATH)) {
    writeText(GAMES_PATH, result.data.toString("utf-8"));
    writeText(MANIFEST_PATH, dumpJson(result.manifest));
  }
  writeText(LAST_KNOWN_PATH, dumpJson(result.lastKnown));
  writeText(LAST_RUN_PATH, dumpJson(result.report));

  process.stdout.write(dumpJson(result.report));
  process.stdout.write(
    `contentChanged=${contentChanged} sha256=${result.manifest.contentSha256}\n`,
  );
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const command = argv[0];
  if (command === "validate") {
    if (!existsSync(SOURCES_PATH)) {
      process.stderr.write(`sources file not found: ${SOURCES_PATH}\n`);
      return 1;
    }
    const errors = validateSources(loadJson(SOURCES_PATH));
    if (errors.length > 0) {
      process.stderr.write("sources.json is invalid:\n");
      for (const error of errors) {
        process.stderr.write(`  - ${error}\n`);
      }
      return 1;
    }
    process.stdout.write("sources.json is valid\n");
    return 0;
  }
  if (command === "sync") {
    return runSync();
  }
  process.stderr.write("usage: sync_catalog.ts <validate|sync>\n");
  return 2;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
