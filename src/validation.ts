import {
  GAME_ID_PATTERN,
  GAME_PLATFORMS,
  MAX_DESCRIPTION_LENGTH,
  MAX_GENRES_LENGTH,
  MAX_TITLE_LENGTH,
  RUNTIME_PLATFORMS,
  SUPPORTED_SOURCE_SCHEMA_VERSIONS,
  VERSION_STRATEGIES,
} from "./constants.ts";
import type { GamePlatform, VersionStrategy } from "./types.ts";
import { isHttpUrl, isRecord } from "./util.ts";

export function validateSources(doc: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(doc)) {
    return ["sources.json must be a JSON object"];
  }
  if (!SUPPORTED_SOURCE_SCHEMA_VERSIONS.includes(doc.schemaVersion as number)) {
    errors.push(
      `sources.schemaVersion must be one of [${SUPPORTED_SOURCE_SCHEMA_VERSIONS.join(", ")}]`,
    );
  }
  const games = doc.games;
  if (!Array.isArray(games) || games.length === 0) {
    errors.push("sources.games must be a non-empty array");
    return errors;
  }

  const seenIds = new Set<string>();
  games.forEach((game, index) => {
    const where = `games[${index}]`;
    if (!isRecord(game)) {
      errors.push(`${where} must be an object`);
      return;
    }

    const gameId = game.gameId;
    if (typeof gameId !== "string" || !gameId.trim()) {
      errors.push(`${where}.gameId is required`);
    } else if (!GAME_ID_PATTERN.test(gameId)) {
      errors.push(`${where}.gameId must be kebab-case (got ${JSON.stringify(gameId)})`);
    } else if (seenIds.has(gameId)) {
      errors.push(`${where}.gameId is duplicated: ${gameId}`);
    } else {
      seenIds.add(gameId);
    }

    const title = game.title;
    if (typeof title !== "string" || !title.trim()) {
      errors.push(`${where}.title is required`);
    } else if (title.length > MAX_TITLE_LENGTH) {
      errors.push(`${where}.title exceeds ${MAX_TITLE_LENGTH} characters`);
    }

    const titleCn = game.titleCn;
    if (
      titleCn !== undefined &&
      titleCn !== null &&
      (typeof titleCn !== "string" || titleCn.length > MAX_TITLE_LENGTH)
    ) {
      errors.push(`${where}.titleCn must be a string up to ${MAX_TITLE_LENGTH} characters`);
    }

    const platform = game.platform;
    if (!GAME_PLATFORMS.includes(platform as GamePlatform)) {
      errors.push(`${where}.platform must be one of [${GAME_PLATFORMS.join(", ")}]`);
    }

    const runtime = game.runtimePlatforms;
    if (!Array.isArray(runtime) || runtime.length === 0) {
      errors.push(`${where}.runtimePlatforms must be a non-empty array`);
    } else {
      const invalid = runtime.filter((item) => !RUNTIME_PLATFORMS.includes(item as never));
      if (invalid.length > 0) {
        errors.push(
          `${where}.runtimePlatforms has invalid values [${invalid
            .map((item) => JSON.stringify(item))
            .join(", ")}]; allowed: [${RUNTIME_PLATFORMS.join(", ")}]`,
        );
      }
    }

    const genres = game.genres;
    if (
      genres !== undefined &&
      genres !== null &&
      (typeof genres !== "string" || genres.length > MAX_GENRES_LENGTH)
    ) {
      errors.push(`${where}.genres must be a string up to ${MAX_GENRES_LENGTH} characters`);
    }

    const description = game.description;
    if (
      description !== undefined &&
      description !== null &&
      (typeof description !== "string" || description.length > MAX_DESCRIPTION_LENGTH)
    ) {
      errors.push(
        `${where}.description must be a string up to ${MAX_DESCRIPTION_LENGTH} characters`,
      );
    }

    for (const fieldName of ["projectUrl", "coverUrl"] as const) {
      const value = game[fieldName];
      if (value !== undefined && value !== null && !isHttpUrl(value)) {
        errors.push(`${where}.${fieldName} must be an http(s) URL`);
      }
    }

    const github = game.github;
    if (!isRecord(github)) {
      errors.push(`${where}.github must be an object with owner/repository`);
    } else {
      for (const fieldName of ["owner", "repository"] as const) {
        const value = github[fieldName];
        if (typeof value !== "string" || !value.trim()) {
          errors.push(`${where}.github.${fieldName} is required`);
        }
      }
      const branch = github.branch;
      if (branch !== undefined && branch !== null && (typeof branch !== "string" || !branch.trim())) {
        errors.push(`${where}.github.branch must be a non-empty string when present`);
      }
    }

    const strategy = game.versionStrategy;
    if (!VERSION_STRATEGIES.includes(strategy as VersionStrategy)) {
      errors.push(`${where}.versionStrategy must be one of [${VERSION_STRATEGIES.join(", ")}]`);
    }

    const fallback = game.fallback;
    if (fallback !== undefined && fallback !== null) {
      if (!Array.isArray(fallback)) {
        errors.push(`${where}.fallback must be an array`);
      } else {
        for (const item of fallback) {
          if (!VERSION_STRATEGIES.includes(item as VersionStrategy)) {
            errors.push(`${where}.fallback has invalid strategy ${JSON.stringify(item)}`);
          }
          if (item === strategy) {
            errors.push(`${where}.fallback must not repeat versionStrategy`);
          }
        }
      }
    }

    const tagPattern = game.tagPattern;
    if (
      tagPattern !== undefined &&
      tagPattern !== null &&
      (typeof tagPattern !== "string" || !tagPattern.trim())
    ) {
      errors.push(`${where}.tagPattern must be a non-empty string when present`);
    }

    if (typeof game.enabled !== "boolean") {
      errors.push(`${where}.enabled must be a boolean`);
    }
  });

  return errors;
}

export function validateCatalog(document: unknown): string[] {
  const errors: string[] = [];
  const games = isRecord(document) ? document.games : undefined;
  if (!Array.isArray(games)) {
    return ["catalog.games must be an array"];
  }
  const seen = new Set<string>();
  games.forEach((game, index) => {
    const gameId = isRecord(game) ? game.gameId : undefined;
    if (typeof gameId !== "string" || !gameId) {
      errors.push(`games[${index}].gameId missing`);
      return;
    }
    if (seen.has(gameId)) {
      errors.push(`duplicate gameId in generated catalog: ${gameId}`);
    }
    seen.add(gameId);
  });
  return errors;
}
