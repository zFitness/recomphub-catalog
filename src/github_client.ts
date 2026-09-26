import {
  MAX_RETRIES,
  REQUEST_TIMEOUT_SECONDS,
  STATUS_ERROR,
  STATUS_OK,
  STATUS_UNAVAILABLE,
} from "./constants.ts";
import { GitHubError, RateLimitError } from "./errors.ts";
import type { SourceGame, SourceStatus, VersionStrategy } from "./types.ts";
import { fnmatch, isRecord } from "./util.ts";

export class VersionInfo {
  version: string;
  versionType: string;
  versionUrl: string;
  revision: string;
  publishedAt: string | null;
  status: SourceStatus;

  constructor(
    version = "",
    versionType = "",
    versionUrl = "",
    revision = "",
    publishedAt: string | null = null,
    status: SourceStatus = STATUS_OK,
  ) {
    this.version = version;
    this.versionType = versionType;
    this.versionUrl = versionUrl;
    this.revision = revision;
    this.publishedAt = publishedAt;
    this.status = status;
  }
}

export interface GitHubApi {
  requests: number;
  rateLimitRemaining: number | null;
  getRepository(owner: string, repo: string): Promise<Record<string, unknown> | null>;
  latestRelease(owner: string, repo: string): Promise<Record<string, unknown> | null>;
  listTags(owner: string, repo: string): Promise<Record<string, unknown>[]>;
  getCommit(owner: string, repo: string, ref: string): Promise<Record<string, unknown> | null>;
  defaultBranch(owner: string, repo: string): Promise<string | null>;
  commitShaForRef?(owner: string, repo: string, ref: string): Promise<string | null>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export type Sleeper = (seconds: number) => void | Promise<void>;

export interface GitHubClientOptions {
  token?: string | null;
  userAgent?: string;
  timeout?: number;
  maxRetries?: number;
  fetchImpl?: FetchLike;
  sleeper?: Sleeper;
}

const RETRYABLE_STATUSES = [500, 502, 503, 504];

export class GitHubClient implements GitHubApi {
  static readonly API_ROOT = "https://api.github.com";

  token: string | null;
  userAgent: string;
  timeout: number;
  maxRetries: number;
  requests = 0;
  rateLimitRemaining: number | null = null;
  rateLimitReset: number | null = null;

  private readonly fetchImpl: FetchLike;
  private readonly sleeper: Sleeper;

  constructor(options: GitHubClientOptions = {}) {
    this.token = options.token ?? null;
    this.userAgent = options.userAgent ?? "recomphub-catalog-sync";
    this.timeout = options.timeout ?? REQUEST_TIMEOUT_SECONDS;
    this.maxRetries = options.maxRetries ?? MAX_RETRIES;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.sleeper = options.sleeper ?? ((seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)));
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "User-Agent": this.userAgent,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    return headers;
  }

  private recordHeaders(headers: Headers | undefined): void {
    if (!headers) return;
    const remaining = headers.get("x-ratelimit-remaining");
    const reset = headers.get("x-ratelimit-reset");
    if (remaining !== null) {
      const parsed = Number.parseInt(remaining, 10);
      if (!Number.isNaN(parsed)) this.rateLimitRemaining = parsed;
    }
    if (reset !== null) {
      const parsed = Number.parseInt(reset, 10);
      if (!Number.isNaN(parsed)) this.rateLimitReset = parsed;
    }
  }

  private static backoff(attempt: number): number {
    return Math.min(2 ** attempt, 8);
  }

  private async get(path: string, params?: Record<string, string | number>): Promise<unknown> {
    let url = path.startsWith("http") ? path : `${GitHubClient.API_ROOT}${path}`;
    if (params) {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        search.set(key, String(value));
      }
      url = `${url}?${search.toString()}`;
    }

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      this.requests += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout * 1000);
      try {
        let response: Response;
        try {
          response = await this.fetchImpl(url, { headers: this.headers(), signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }

        this.recordHeaders(response.headers);

        if (response.status === 404) {
          return null;
        }

        if (response.status === 403 || response.status === 429) {
          const retryAfter = response.headers.get("retry-after");
          const exhausted = this.rateLimitRemaining === 0;
          if (retryAfter || exhausted) {
            throw new RateLimitError(`GitHub rate limit at ${url} (status ${response.status})`);
          }
          if (attempt < this.maxRetries) {
            await this.sleeper(GitHubClient.backoff(attempt));
            continue;
          }
          lastError = new GitHubError(`HTTP ${response.status} for ${url}`);
          continue;
        }

        if (RETRYABLE_STATUSES.includes(response.status) && attempt < this.maxRetries) {
          await this.sleeper(GitHubClient.backoff(attempt));
          continue;
        }

        if (!response.ok) {
          lastError = new GitHubError(`HTTP ${response.status} for ${url}`);
          continue;
        }

        const payload = await response.text();
        try {
          return payload ? JSON.parse(payload) : null;
        } catch (error) {
          lastError = new GitHubError(
            `${(error as Error).name}: ${(error as Error).message} for ${url}`,
          );
          if (attempt < this.maxRetries) {
            await this.sleeper(GitHubClient.backoff(attempt));
          }
        }
      } catch (error) {
        if (error instanceof RateLimitError) {
          throw error;
        }
        if (error instanceof GitHubError) {
          throw error;
        }
        lastError = new GitHubError(
          `${(error as Error).name}: ${(error as Error).message} for ${url}`,
        );
        if (attempt < this.maxRetries) {
          await this.sleeper(GitHubClient.backoff(attempt));
        }
      }
    }

    throw lastError ?? new GitHubError(`request failed for ${url}`);
  }

  async getRepository(owner: string, repo: string): Promise<Record<string, unknown> | null> {
    return (await this.get(`/repos/${owner}/${repo}`)) as Record<string, unknown> | null;
  }

  async latestRelease(owner: string, repo: string): Promise<Record<string, unknown> | null> {
    return (await this.get(`/repos/${owner}/${repo}/releases/latest`)) as Record<string, unknown> | null;
  }

  async listTags(owner: string, repo: string): Promise<Record<string, unknown>[]> {
    const payload = await this.get(`/repos/${owner}/${repo}/tags`, { per_page: 100 });
    return Array.isArray(payload) ? (payload as Record<string, unknown>[]) : [];
  }

  async getCommit(owner: string, repo: string, ref: string): Promise<Record<string, unknown> | null> {
    return (await this.get(`/repos/${owner}/${repo}/commits/${ref}`)) as Record<string, unknown> | null;
  }

  async defaultBranch(owner: string, repo: string): Promise<string | null> {
    const repository = await this.getRepository(owner, repo);
    if (isRecord(repository) && typeof repository.default_branch === "string") {
      return repository.default_branch;
    }
    return null;
  }

  async commitShaForRef(owner: string, repo: string, ref: string): Promise<string | null> {
    const commit = await this.getCommit(owner, repo, ref);
    if (isRecord(commit) && typeof commit.sha === "string") {
      return commit.sha;
    }
    return null;
  }
}

function committerDate(commit: Record<string, unknown>): string | null {
  const inner = isRecord(commit.commit) ? commit.commit : {};
  const committer = isRecord(inner.committer) ? inner.committer : {};
  return typeof committer.date === "string" ? committer.date : null;
}

export async function resolveStrategy(
  strategy: VersionStrategy,
  source: SourceGame,
  client: GitHubApi,
): Promise<VersionInfo | null> {
  const github = source.github;
  const owner = github.owner;
  const repository = github.repository;

  if (strategy === "release") {
    const release = await client.latestRelease(owner, repository);
    if (!isRecord(release) || !release.tag_name) {
      return null;
    }
    const tag = String(release.tag_name);
    let revision: string | null = null;
    if (typeof client.commitShaForRef === "function") {
      try {
        revision = await client.commitShaForRef(owner, repository, tag);
      } catch (error) {
        if (!(error instanceof GitHubError)) throw error;
        revision = null;
      }
    }
    return new VersionInfo(
      tag,
      "release",
      (release.html_url as string) || `https://github.com/${owner}/${repository}/releases`,
      revision || tag,
      typeof release.published_at === "string" ? release.published_at : null,
    );
  }

  if (strategy === "tag") {
    const pattern = source.tagPattern ?? null;
    for (const tag of await client.listTags(owner, repository)) {
      const name = tag.name;
      if (typeof name !== "string" || !name) {
        continue;
      }
      if (pattern && !fnmatch(name, pattern)) {
        continue;
      }
      const commitRef = isRecord(tag.commit) ? tag.commit : {};
      const sha = typeof commitRef.sha === "string" && commitRef.sha ? commitRef.sha : name;
      let publishedAt: string | null = null;
      try {
        const commit = await client.getCommit(owner, repository, sha);
        if (isRecord(commit)) {
          publishedAt = committerDate(commit);
        }
      } catch (error) {
        if (!(error instanceof GitHubError)) throw error;
        publishedAt = null;
      }
      return new VersionInfo(
        name,
        "tag",
        `https://github.com/${owner}/${repository}/commit/${sha}`,
        sha,
        publishedAt,
      );
    }
    return null;
  }

  if (strategy === "commit") {
    const branch = github.branch || (await client.defaultBranch(owner, repository));
    if (!branch) {
      return null;
    }
    const commit = await client.getCommit(owner, repository, branch);
    if (!isRecord(commit) || !commit.sha) {
      return null;
    }
    const sha = String(commit.sha);
    return new VersionInfo(
      sha.slice(0, 7),
      "commit",
      (commit.html_url as string) || `https://github.com/${owner}/${repository}/commit/${sha}`,
      sha,
      committerDate(commit),
    );
  }

  return null;
}

export async function resolveVersion(source: SourceGame, client: GitHubApi): Promise<VersionInfo> {
  const order: VersionStrategy[] = [source.versionStrategy, ...(source.fallback ?? [])];
  let sawError = false;
  for (const strategy of order) {
    let info: VersionInfo | null;
    try {
      info = await resolveStrategy(strategy, source, client);
    } catch (error) {
      if (error instanceof RateLimitError) {
        throw error;
      }
      if (error instanceof GitHubError) {
        sawError = true;
        continue;
      }
      throw error;
    }
    if (info !== null) {
      return info;
    }
  }
  return new VersionInfo("", "", "", "", null, sawError ? STATUS_ERROR : STATUS_UNAVAILABLE);
}
