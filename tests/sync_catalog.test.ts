import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  buildEntry,
  computeCatalog,
  generateCatalog,
} from "../src/catalog.ts";
import { STATUS_ERROR, STATUS_OK, STATUS_UNAVAILABLE } from "../src/constants.ts";
import { GitHubError, RateLimitError } from "../src/errors.ts";
import {
  GitHubClient,
  VersionInfo,
  resolveVersion,
  type GitHubApi,
} from "../src/github_client.ts";
import type { SourceGame } from "../src/types.ts";
import { validateCatalog, validateSources } from "../src/validation.ts";

const HERE = import.meta.dirname;
const FIXTURES = path.join(HERE, "fixtures");

function loadFixture(name: string): any {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), "utf-8"));
}

interface FakeClientOptions {
  release?: any;
  tags?: any[];
  commit?: any;
  defaultBranch?: string;
  fail?: boolean;
  rateLimited?: boolean;
}

class FakeClient implements GitHubApi {
  requests = 0;
  rateLimitRemaining: number | null = 5000;
  release: any;
  tags: any[];
  commit: any;
  defaultBranchValue: string;
  fail: boolean;
  rateLimited: boolean;

  constructor(options: FakeClientOptions = {}) {
    this.release = options.release ?? null;
    this.tags = options.tags ?? [];
    this.commit = options.commit ?? null;
    this.defaultBranchValue = options.defaultBranch ?? "main";
    this.fail = options.fail ?? false;
    this.rateLimited = options.rateLimited ?? false;
  }

  private guard(): void {
    this.requests += 1;
    if (this.rateLimited) {
      throw new RateLimitError("rate limited");
    }
    if (this.fail) {
      throw new GitHubError("network down");
    }
  }

  async latestRelease(): Promise<any> {
    this.guard();
    return this.release;
  }

  async listTags(): Promise<any[]> {
    this.guard();
    return this.tags;
  }

  async getCommit(): Promise<any> {
    this.guard();
    return this.commit;
  }

  async defaultBranch(): Promise<string | null> {
    this.guard();
    return this.defaultBranchValue;
  }

  async commitShaForRef(): Promise<string | null> {
    this.guard();
    return this.commit?.sha ?? null;
  }

  async getRepository(): Promise<any> {
    this.guard();
    return { default_branch: this.defaultBranchValue };
  }
}

function makeClient(options: FakeClientOptions = {}): FakeClient {
  return new FakeClient({
    release: options.release === undefined ? loadFixture("github_release.json") : options.release,
    tags: options.tags ?? loadFixture("github_tags.json"),
    commit: options.commit ?? loadFixture("github_commit.json"),
    ...options,
  });
}

describe("ValidationTests", () => {
  it("test_valid_sources_pass", () => {
    assert.deepEqual(validateSources(loadFixture("sources_valid.json")), []);
  });

  it("test_duplicate_game_id_fails", () => {
    const errors = validateSources(loadFixture("sources_duplicate_id.json"));
    assert.ok(errors.some((error) => error.includes("duplicated")), String(errors));
  });

  it("test_missing_runtime_platform_fails", () => {
    const errors = validateSources(loadFixture("sources_missing_field.json"));
    assert.ok(errors.some((error) => error.includes("runtimePlatforms")), String(errors));
  });

  it("test_invalid_runtime_platform_fails", () => {
    const doc = loadFixture("sources_valid.json");
    doc.games[0].runtimePlatforms = ["dreamcast"];
    const errors = validateSources(doc);
    assert.ok(errors.some((error) => error.includes("runtimePlatforms")), String(errors));
  });

  it("test_bad_url_and_strategy_fail", () => {
    const doc = loadFixture("sources_valid.json");
    doc.games[0].projectUrl = "ftp://example.com";
    doc.games[0].versionStrategy = "semver";
    const errors = validateSources(doc);
    assert.ok(errors.some((error) => error.includes("projectUrl")), String(errors));
    assert.ok(errors.some((error) => error.includes("versionStrategy")), String(errors));
  });
});

describe("ResolutionTests", () => {
  it("test_release_strategy", async () => {
    const info = await resolveVersion(loadFixture("sources_valid.json").games[0], makeClient());
    assert.equal(info.status, STATUS_OK);
    assert.equal(info.version, "v2.0.1");
    assert.equal(info.versionType, "release");
    assert.equal(info.revision, "422d7bb1b6c8d973cccf8b3d0b226a57ac3cc8c7");
  });

  it("test_release_missing_falls_back_to_tag", async () => {
    const source = loadFixture("sources_valid.json").games[0];
    const info = await resolveVersion(source, makeClient({ release: null }));
    assert.equal(info.status, STATUS_OK);
    assert.equal(info.versionType, "tag");
    assert.equal(info.version, "v2.0.1");
  });

  it("test_release_missing_without_fallback_is_unavailable", async () => {
    const source = structuredClone(loadFixture("sources_valid.json").games[0]);
    source.fallback = [];
    const info = await resolveVersion(source, makeClient({ release: null }));
    assert.equal(info.status, STATUS_UNAVAILABLE);
  });

  it("test_tag_pattern_filters", async () => {
    const source = structuredClone(loadFixture("sources_valid.json").games[0]);
    source.versionStrategy = "tag";
    source.fallback = [];
    source.tagPattern = "v2.*";
    let info = await resolveVersion(source, makeClient());
    assert.equal(info.version, "v2.0.1");
    source.tagPattern = "nightly-*";
    info = await resolveVersion(source, makeClient());
    assert.equal(info.status, STATUS_UNAVAILABLE);
  });

  it("test_commit_strategy_uses_default_branch", async () => {
    const source = structuredClone(loadFixture("sources_valid.json").games[0]);
    source.versionStrategy = "commit";
    source.fallback = [];
    delete source.github.branch;
    const info = await resolveVersion(source, makeClient());
    assert.equal(info.versionType, "commit");
    assert.equal(info.version, "422d7bb");
  });

  it("test_transport_error_is_error_status", async () => {
    const source = loadFixture("sources_valid.json").games[0];
    const info = await resolveVersion(source, makeClient({ fail: true }));
    assert.equal(info.status, STATUS_ERROR);
  });

  it("test_rate_limit_propagates", async () => {
    const source = loadFixture("sources_valid.json").games[0];
    await assert.rejects(
      () => resolveVersion(source, makeClient({ rateLimited: true })),
      RateLimitError,
    );
  });
});

describe("GenerationTests", () => {
  it("test_manifest_matches_content_hash", async () => {
    const entries = [
      buildEntry(
        loadFixture("sources_valid.json").games[0],
        new VersionInfo("v2.0.1", "release", "https://example.com", "abc", "2026-09-20T00:36:12Z"),
        null,
        "2026-09-25T00:00:00Z",
      ),
    ];
    const { data, manifest } = generateCatalog(entries, "2026-09-25T00:00:00Z");
    const { createHash } = await import("node:crypto");
    assert.equal(manifest.contentSha256, createHash("sha256").update(data).digest("hex"));
    assert.equal(manifest.gameCount, 1);
    assert.ok(manifest.catalogRevision.startsWith("sha256-"));
  });

  it("test_catalog_sorted_by_game_id", () => {
    const base = loadFixture("sources_valid.json").games[0];
    const first = structuredClone(base);
    first.gameId = "zzz";
    const second = structuredClone(base);
    second.gameId = "aaa";
    const info = new VersionInfo("v1", "release", "u", "r");
    const entries = [
      buildEntry(first, info, null, "t"),
      buildEntry(second, info, null, "t"),
    ];
    const { data } = generateCatalog(entries, "t");
    const document = JSON.parse(data.toString("utf-8"));
    assert.deepEqual(
      document.games.map((game: any) => game.gameId),
      ["aaa", "zzz"],
    );
  });

  it("test_duplicate_detected_in_generated_catalog", () => {
    const errors = validateCatalog({ games: [{ gameId: "a" }, { gameId: "a" }] });
    assert.ok(errors.some((error) => error.includes("duplicate")), String(errors));
  });

  it("test_disabled_source_excluded", async () => {
    const doc = loadFixture("sources_valid.json");
    doc.games[0].enabled = false;
    const result = await computeCatalog(doc, makeClient(), {}, "2026-09-25T00:00:00Z");
    const document = JSON.parse(result.data.toString("utf-8"));
    assert.deepEqual(document.games, []);
    assert.equal(result.report.skipped, 1);
  });

  it("test_golden_output_is_byte_identical", async () => {
    const result = await computeCatalog(
      loadFixture("sources_valid.json"),
      makeClient(),
      {},
      "2026-09-25T00:00:00Z",
    );
    const goldenGames = readFileSync(path.join(FIXTURES, "golden_games.json"));
    const goldenManifest = loadFixture("golden_manifest.json");
    assert.ok(result.data.equals(goldenGames));
    assert.deepEqual(result.manifest, goldenManifest);
  });
});

describe("SyncFlowTests", () => {
  it("test_new_source_unavailable_is_fatal", async () => {
    const source = structuredClone(loadFixture("sources_valid.json").games[0]);
    source.fallback = [];
    const doc = { schemaVersion: 1, games: [source] };
    const result = await computeCatalog(doc, makeClient({ release: null }), {}, "2026-09-25T00:00:00Z");
    assert.ok(result.fatal.includes("dusklight"));
  });

  it("test_existing_source_failure_keeps_last_known", async () => {
    const doc = loadFixture("sources_valid.json");
    const lastKnown = {
      dusklight: {
        version: "v2.0.0",
        versionType: "release",
        versionUrl: "https://example.com/v2.0.0",
        revision: "oldsha",
        publishedAt: "2026-09-19T00:04:12Z",
        observedAt: "2026-09-20T00:00:00Z",
        status: "ok",
      },
    };
    const result = await computeCatalog(doc, makeClient({ fail: true }), lastKnown as any, "2026-09-25T00:00:00Z");
    assert.deepEqual(result.fatal, []);
    const document = JSON.parse(result.data.toString("utf-8"));
    const entry = document.games[0];
    assert.equal(entry.source.status, STATUS_ERROR);
    assert.equal(entry.source.version, "v2.0.0");
    assert.equal(entry.source.observedAt, "2026-09-20T00:00:00Z");
  });

  it("test_no_change_produces_identical_output", async () => {
    const doc = loadFixture("sources_valid.json");
    const first = await computeCatalog(doc, makeClient(), {}, "2026-09-25T00:00:00Z");
    const second = await computeCatalog(doc, makeClient(), first.lastKnown, "2026-09-26T00:00:00Z");
    assert.ok(first.data.equals(second.data));
    assert.equal(first.manifest.contentSha256, second.manifest.contentSha256);
  });

  it("test_version_change_updates_observed_at", async () => {
    const doc = loadFixture("sources_valid.json");
    const first = await computeCatalog(doc, makeClient(), {}, "2026-09-25T00:00:00Z");
    const newRelease = structuredClone(loadFixture("github_release.json"));
    newRelease.tag_name = "v2.0.2";
    newRelease.html_url = "https://github.com/TwilitRealm/dusklight/releases/tag/v2.0.2";
    const second = await computeCatalog(doc, makeClient({ release: newRelease }), first.lastKnown, "2026-09-26T00:00:00Z");
    assert.ok(!first.data.equals(second.data));
    const document = JSON.parse(second.data.toString("utf-8"));
    assert.equal(document.games[0].source.observedAt, "2026-09-26T00:00:00Z");
  });

  it("test_rate_limit_blocks_publication", async () => {
    const doc = loadFixture("sources_valid.json");
    const result = await computeCatalog(doc, makeClient({ rateLimited: true }), {}, "2026-09-25T00:00:00Z");
    assert.ok(result.fatal.includes("__rate_limited__"));
  });

  it("test_report_contains_run_statistics", async () => {
    const doc = loadFixture("sources_valid.json");
    const result = await computeCatalog(doc, makeClient(), {}, "2026-09-25T00:00:00Z");
    assert.equal(result.report.success, 1);
    assert.equal(result.report.failed, 0);
    assert.equal(result.report.enabledSources, 1);
    assert.ok("requests" in result.report);
  });
});

describe("ClientTransportTests", () => {
  it("test_retry_after_raises_rate_limit", async () => {
    const fetchImpl = async () =>
      new Response(null, { status: 403, headers: { "retry-after": "60" } });
    const client = new GitHubClient({ fetchImpl, sleeper: () => {} });
    await assert.rejects(() => client.latestRelease("owner", "repo"), RateLimitError);
  });

  it("test_404_returns_none", async () => {
    const fetchImpl = async () => new Response(null, { status: 404 });
    const client = new GitHubClient({ fetchImpl, sleeper: () => {} });
    assert.equal(await client.latestRelease("owner", "repo"), null);
  });

  it("test_timeout_retries_then_fails", async () => {
    let calls = 0;
    const fetchImpl = async (): Promise<Response> => {
      calls += 1;
      throw new Error("timed out");
    };
    const client = new GitHubClient({ fetchImpl, sleeper: () => {}, maxRetries: 2 });
    await assert.rejects(() => client.latestRelease("owner", "repo"), GitHubError);
    assert.equal(calls, 3);
  });

  it("test_successful_parsing_and_rate_limit_headers", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ tag_name: "v1" }), {
        status: 200,
        headers: { "x-ratelimit-remaining": "4999" },
      });
    const client = new GitHubClient({ fetchImpl, sleeper: () => {} });
    const release = await client.latestRelease("owner", "repo");
    assert.equal(release?.tag_name, "v1");
    assert.equal(client.rateLimitRemaining, 4999);
    assert.equal(client.requests, 1);
  });
});
