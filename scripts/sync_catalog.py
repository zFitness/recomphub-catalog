#!/usr/bin/env python3
"""RecompHub catalog synchronizer.

Reads the human-maintained source registry (``sources/sources.json``), queries
the GitHub REST API for each enabled source, merges the human fields with the
observed repository facts, and writes the normalized catalog
(``catalog/games.json``) plus a small update manifest
(``catalog/games.manifest.json``).

Commands::

    python scripts/sync_catalog.py validate   # validate sources.json only
    python scripts/sync_catalog.py sync       # resolve, merge, generate, write

Only the Python standard library is used so the GitHub Actions workflow does
not need third-party packages. The module is written so the pure computation
(:func:`compute_catalog`) can be tested with a fake client and no network.
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

SCHEMA_VERSION = 1
SUPPORTED_SOURCE_SCHEMA_VERSIONS = {1}

MAX_WORKERS = 4
MAX_RETRIES = 2
REQUEST_TIMEOUT_SECONDS = 10
RATE_LIMIT_SAFETY_MARGIN = 50

VERSION_STRATEGIES = ("release", "tag", "commit")
RUNTIME_PLATFORMS = ("windows", "macos", "linux", "android", "ios")
GAME_PLATFORMS = (
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
)

STATUS_OK = "ok"
STATUS_UNAVAILABLE = "unavailable"
STATUS_ERROR = "error"

MAX_TITLE_LENGTH = 120
MAX_DESCRIPTION_LENGTH = 2000
MAX_GENRES_LENGTH = 120

REPO_ROOT = Path(__file__).resolve().parent.parent
SOURCES_PATH = REPO_ROOT / "sources" / "sources.json"
CATALOG_DIR = REPO_ROOT / "catalog"
GAMES_PATH = CATALOG_DIR / "games.json"
MANIFEST_PATH = CATALOG_DIR / "games.manifest.json"
STATE_DIR = REPO_ROOT / "state"
LAST_KNOWN_PATH = STATE_DIR / "last-known.json"
LAST_RUN_PATH = STATE_DIR / "last-run.json"

GAME_ID_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


class SyncError(Exception):
    """Raised when the sync cannot produce a safe, publishable catalog."""


class GitHubError(Exception):
    """Network/transport error while talking to the GitHub API."""


class RateLimitError(GitHubError):
    """GitHub rate limit (403/429) with no safe room left in this run."""


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #
def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def dump_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def _is_http_url(value: Any) -> bool:
    return isinstance(value, str) and (value.startswith("https://") or value.startswith("http://"))


# --------------------------------------------------------------------------- #
# Source registry validation (task 2.1)
# --------------------------------------------------------------------------- #
def validate_sources(doc: Any) -> list[str]:
    errors: list[str] = []
    if not isinstance(doc, dict):
        return ["sources.json must be a JSON object"]
    if doc.get("schemaVersion") not in SUPPORTED_SOURCE_SCHEMA_VERSIONS:
        errors.append(
            f"sources.schemaVersion must be one of {sorted(SUPPORTED_SOURCE_SCHEMA_VERSIONS)}"
        )
    games = doc.get("games")
    if not isinstance(games, list) or not games:
        errors.append("sources.games must be a non-empty array")
        return errors

    seen_ids: set[str] = set()
    for index, game in enumerate(games):
        where = f"games[{index}]"
        if not isinstance(game, dict):
            errors.append(f"{where} must be an object")
            continue

        game_id = game.get("gameId")
        if not isinstance(game_id, str) or not game_id.strip():
            errors.append(f"{where}.gameId is required")
        elif not GAME_ID_PATTERN.match(game_id):
            errors.append(f"{where}.gameId must be kebab-case (got {game_id!r})")
        elif game_id in seen_ids:
            errors.append(f"{where}.gameId is duplicated: {game_id}")
        else:
            seen_ids.add(game_id)

        title = game.get("title")
        if not isinstance(title, str) or not title.strip():
            errors.append(f"{where}.title is required")
        elif len(title) > MAX_TITLE_LENGTH:
            errors.append(f"{where}.title exceeds {MAX_TITLE_LENGTH} characters")

        title_cn = game.get("titleCn")
        if title_cn is not None and (not isinstance(title_cn, str) or len(title_cn) > MAX_TITLE_LENGTH):
            errors.append(f"{where}.titleCn must be a string up to {MAX_TITLE_LENGTH} characters")

        platform = game.get("platform")
        if platform not in GAME_PLATFORMS:
            errors.append(f"{where}.platform must be one of {list(GAME_PLATFORMS)}")

        runtime = game.get("runtimePlatforms")
        if not isinstance(runtime, list) or not runtime:
            errors.append(f"{where}.runtimePlatforms must be a non-empty array")
        else:
            invalid = [item for item in runtime if item not in RUNTIME_PLATFORMS]
            if invalid:
                errors.append(
                    f"{where}.runtimePlatforms has invalid values {invalid}; "
                    f"allowed: {list(RUNTIME_PLATFORMS)}"
                )

        genres = game.get("genres")
        if genres is not None and (not isinstance(genres, str) or len(genres) > MAX_GENRES_LENGTH):
            errors.append(f"{where}.genres must be a string up to {MAX_GENRES_LENGTH} characters")

        description = game.get("description")
        if description is not None and (
            not isinstance(description, str) or len(description) > MAX_DESCRIPTION_LENGTH
        ):
            errors.append(
                f"{where}.description must be a string up to {MAX_DESCRIPTION_LENGTH} characters"
            )

        for field_name in ("projectUrl", "coverUrl"):
            value = game.get(field_name)
            if value is not None and not _is_http_url(value):
                errors.append(f"{where}.{field_name} must be an http(s) URL")

        github = game.get("github")
        if not isinstance(github, dict):
            errors.append(f"{where}.github must be an object with owner/repository")
        else:
            for field_name in ("owner", "repository"):
                value = github.get(field_name)
                if not isinstance(value, str) or not value.strip():
                    errors.append(f"{where}.github.{field_name} is required")
            branch = github.get("branch")
            if branch is not None and (not isinstance(branch, str) or not branch.strip()):
                errors.append(f"{where}.github.branch must be a non-empty string when present")

        strategy = game.get("versionStrategy")
        if strategy not in VERSION_STRATEGIES:
            errors.append(f"{where}.versionStrategy must be one of {list(VERSION_STRATEGIES)}")

        fallback = game.get("fallback")
        if fallback is not None:
            if not isinstance(fallback, list):
                errors.append(f"{where}.fallback must be an array")
            else:
                for item in fallback:
                    if item not in VERSION_STRATEGIES:
                        errors.append(f"{where}.fallback has invalid strategy {item!r}")
                    if item == strategy:
                        errors.append(f"{where}.fallback must not repeat versionStrategy")

        pattern = game.get("tagPattern")
        if pattern is not None and (not isinstance(pattern, str) or not pattern.strip()):
            errors.append(f"{where}.tagPattern must be a non-empty string when present")

        if not isinstance(game.get("enabled"), bool):
            errors.append(f"{where}.enabled must be a boolean")

    return errors


# --------------------------------------------------------------------------- #
# GitHub REST client (tasks 3.1-3.3)
# --------------------------------------------------------------------------- #
@dataclass
class VersionInfo:
    version: str
    version_type: str
    version_url: str
    revision: str
    published_at: Optional[str] = None
    status: str = STATUS_OK


class GitHubClient:
    API_ROOT = "https://api.github.com"

    def __init__(
        self,
        token: Optional[str] = None,
        user_agent: str = "recomphub-catalog-sync",
        timeout: int = REQUEST_TIMEOUT_SECONDS,
        max_retries: int = MAX_RETRIES,
        opener: Callable[..., Any] = urllib.request.urlopen,
        sleeper: Callable[[float], None] = time.sleep,
    ) -> None:
        self.token = token
        self.user_agent = user_agent
        self.timeout = timeout
        self.max_retries = max_retries
        self._opener = opener
        self._sleep = sleeper
        self._lock = threading.Lock()
        self.requests = 0
        self.rate_limit_remaining: Optional[int] = None
        self.rate_limit_reset: Optional[int] = None

    # -- low level --------------------------------------------------------- #
    def _headers(self) -> dict[str, str]:
        headers = {
            "User-Agent": self.user_agent,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers

    def _record_headers(self, headers: Any) -> None:
        remaining = headers.get("x-ratelimit-remaining") if headers else None
        reset = headers.get("x-ratelimit-reset") if headers else None
        if remaining is not None:
            try:
                self.rate_limit_remaining = int(remaining)
            except (TypeError, ValueError):
                pass
        if reset is not None:
            try:
                self.rate_limit_reset = int(reset)
            except (TypeError, ValueError):
                pass

    def _get(self, path: str, params: Optional[dict[str, Any]] = None) -> Any:
        url = path if path.startswith("http") else f"{self.API_ROOT}{path}"
        if params:
            url = f"{url}?{urllib.parse.urlencode(params)}"

        last_error: Optional[Exception] = None
        for attempt in range(self.max_retries + 1):
            with self._lock:
                self.requests += 1
            request = urllib.request.Request(url, headers=self._headers())
            try:
                with self._opener(request, timeout=self.timeout) as response:
                    self._record_headers(getattr(response, "headers", None))
                    payload = response.read().decode("utf-8")
                    return json.loads(payload) if payload else None
            except urllib.error.HTTPError as error:
                self._record_headers(error.headers)
                if error.code == 404:
                    return None
                if error.code in (403, 429):
                    retry_after = None
                    try:
                        retry_after = error.headers.get("retry-after") if error.headers else None
                    except Exception:  # pragma: no cover - defensive
                        retry_after = None
                    exhausted = self.rate_limit_remaining == 0
                    if retry_after or exhausted:
                        raise RateLimitError(
                            f"GitHub rate limit at {url} (status {error.code})"
                        ) from error
                    if attempt < self.max_retries:
                        self._sleep(self._backoff(attempt))
                        continue
                    last_error = GitHubError(f"HTTP {error.code} for {url}")
                elif error.code in (500, 502, 503, 504) and attempt < self.max_retries:
                    self._sleep(self._backoff(attempt))
                    continue
                else:
                    last_error = GitHubError(f"HTTP {error.code} for {url}")
            except (urllib.error.URLError, socket.timeout, TimeoutError, json.JSONDecodeError) as error:
                last_error = GitHubError(f"{type(error).__name__}: {error} for {url}")
                if attempt < self.max_retries:
                    self._sleep(self._backoff(attempt))
                    continue
            except OSError as error:  # pragma: no cover - defensive
                last_error = GitHubError(f"{type(error).__name__}: {error} for {url}")

        raise last_error or GitHubError(f"request failed for {url}")

    @staticmethod
    def _backoff(attempt: int) -> float:
        return min(2 ** attempt, 8)

    def _rate_limit_exhausted(self) -> bool:
        remaining = self.rate_limit_remaining
        return remaining is not None and remaining <= RATE_LIMIT_SAFETY_MARGIN

    # -- high level -------------------------------------------------------- #
    def get_repository(self, owner: str, repo: str) -> Optional[dict[str, Any]]:
        return self._get(f"/repos/{owner}/{repo}")

    def latest_release(self, owner: str, repo: str) -> Optional[dict[str, Any]]:
        return self._get(f"/repos/{owner}/{repo}/releases/latest")

    def list_tags(self, owner: str, repo: str) -> list[dict[str, Any]]:
        payload = self._get(f"/repos/{owner}/{repo}/tags", {"per_page": 100})
        return payload if isinstance(payload, list) else []

    def get_commit(self, owner: str, repo: str, ref: str) -> Optional[dict[str, Any]]:
        return self._get(f"/repos/{owner}/{repo}/commits/{ref}")

    def default_branch(self, owner: str, repo: str) -> Optional[str]:
        repository = self.get_repository(owner, repo)
        if isinstance(repository, dict):
            return repository.get("default_branch")
        return None

    def commit_sha_for_ref(self, owner: str, repo: str, ref: str) -> Optional[str]:
        commit = self.get_commit(owner, repo, ref)
        if isinstance(commit, dict):
            return commit.get("sha")
        return None


def _resolve_strategy(strategy: str, source: dict[str, Any], client: GitHubClient) -> Optional[VersionInfo]:
    github = source["github"]
    owner = github["owner"]
    repository = github["repository"]

    if strategy == "release":
        release = client.latest_release(owner, repository)
        if not isinstance(release, dict) or not release.get("tag_name"):
            return None
        tag = release["tag_name"]
        revision = None
        if hasattr(client, "commit_sha_for_ref"):
            try:
                revision = client.commit_sha_for_ref(owner, repository, tag)
            except GitHubError:
                revision = None
        return VersionInfo(
            version=tag,
            version_type="release",
            version_url=release.get("html_url") or f"https://github.com/{owner}/{repository}/releases",
            revision=revision or tag,
            published_at=release.get("published_at"),
        )

    if strategy == "tag":
        pattern = source.get("tagPattern")
        for tag in client.list_tags(owner, repository):
            name = tag.get("name")
            if not name:
                continue
            if pattern and not fnmatch.fnmatch(name, pattern):
                continue
            sha = (tag.get("commit") or {}).get("sha") or name
            published_at = None
            try:
                commit = client.get_commit(owner, repository, sha)
                if isinstance(commit, dict):
                    published_at = (
                        (commit.get("commit") or {}).get("committer") or {}
                    ).get("date")
            except GitHubError:
                published_at = None
            return VersionInfo(
                version=name,
                version_type="tag",
                version_url=f"https://github.com/{owner}/{repository}/commit/{sha}",
                revision=sha,
                published_at=published_at,
            )
        return None

    if strategy == "commit":
        branch = github.get("branch") or client.default_branch(owner, repository)
        if not branch:
            return None
        commit = client.get_commit(owner, repository, branch)
        if not isinstance(commit, dict) or not commit.get("sha"):
            return None
        sha = commit["sha"]
        return VersionInfo(
            version=sha[:7],
            version_type="commit",
            version_url=commit.get("html_url") or f"https://github.com/{owner}/{repository}/commit/{sha}",
            revision=sha,
            published_at=((commit.get("commit") or {}).get("committer") or {}).get("date"),
        )

    return None


def resolve_version(source: dict[str, Any], client: GitHubClient) -> VersionInfo:
    order = [source["versionStrategy"]] + list(source.get("fallback") or [])
    saw_error = False
    for strategy in order:
        try:
            info = _resolve_strategy(strategy, source, client)
        except RateLimitError:
            raise
        except GitHubError:
            saw_error = True
            continue
        if info is not None:
            return info
    return VersionInfo("", "", "", "", None, STATUS_ERROR if saw_error else STATUS_UNAVAILABLE)


# --------------------------------------------------------------------------- #
# Merge human fields with observed facts (task 2.2)
# --------------------------------------------------------------------------- #
def _version_fields(version: VersionInfo) -> dict[str, Any]:
    return {
        "version": version.version,
        "versionType": version.version_type,
        "versionUrl": version.version_url,
        "revision": version.revision,
        "publishedAt": version.published_at,
    }


def build_entry(
    source: dict[str, Any],
    version: VersionInfo,
    previous: Optional[dict[str, Any]],
    observed_at: str,
) -> dict[str, Any]:
    github = source["github"]
    owner = github["owner"]
    repository = github["repository"]

    entry: dict[str, Any] = {
        "gameId": source["gameId"],
        "title": source["title"],
        "titleCn": source.get("titleCn"),
        "platform": source["platform"],
        "runtimePlatforms": list(source["runtimePlatforms"]),
        "genres": source.get("genres"),
        "description": source.get("description"),
        "projectUrl": source.get("projectUrl") or f"https://github.com/{owner}/{repository}",
        "coverUrl": source.get("coverUrl"),
        "source": {
            "owner": owner,
            "repository": repository,
            "url": f"https://github.com/{owner}/{repository}",
        },
    }

    if version.status == STATUS_OK:
        unchanged = bool(
            previous
            and previous.get("version") == version.version
            and previous.get("revision") == version.revision
            and previous.get("versionType") == version.version_type
        )
        entry["source"].update(_version_fields(version))
        entry["source"]["observedAt"] = previous.get("observedAt") if unchanged else observed_at
        entry["source"]["status"] = STATUS_OK
    elif previous and previous.get("version"):
        for key, value in previous.items():
            if key != "status":
                entry["source"][key] = value
        entry["source"]["status"] = version.status
    else:
        entry["source"].update(_version_fields(version))
        entry["source"]["observedAt"] = observed_at
        entry["source"]["status"] = version.status

    return entry


# --------------------------------------------------------------------------- #
# Normalized output + manifest (task 2.3)
# --------------------------------------------------------------------------- #
def generate_catalog(entries: list[dict[str, Any]], generated_at: str) -> tuple[bytes, dict[str, Any]]:
    games = sorted(entries, key=lambda item: item["gameId"])
    document = {"schemaVersion": SCHEMA_VERSION, "games": games}
    text = dump_json(document)
    data = text.encode("utf-8")
    digest = hashlib.sha256(data).hexdigest()
    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "catalogRevision": f"sha256-{digest[:16]}",
        "contentSha256": digest,
        "generatedAt": generated_at,
        "gameCount": len(games),
        "dataUrl": "games.json",
    }
    return data, manifest


def validate_catalog(document: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    games = document.get("games")
    if not isinstance(games, list):
        return ["catalog.games must be an array"]
    seen: set[str] = set()
    for index, game in enumerate(games):
        game_id = game.get("gameId")
        if not isinstance(game_id, str) or not game_id:
            errors.append(f"games[{index}].gameId missing")
            continue
        if game_id in seen:
            errors.append(f"duplicate gameId in generated catalog: {game_id}")
        seen.add(game_id)
    return errors


# --------------------------------------------------------------------------- #
# Orchestration (task 2.2/3.4/3.5)
# --------------------------------------------------------------------------- #
@dataclass
class CatalogResult:
    data: bytes
    manifest: dict[str, Any]
    last_known: dict[str, Any]
    report: dict[str, Any]
    fatal: list[str]


def compute_catalog(
    sources_doc: dict[str, Any],
    client: GitHubClient,
    last_known: dict[str, Any],
    observed_at: Optional[str] = None,
    max_workers: int = MAX_WORKERS,
) -> CatalogResult:
    observed_at = observed_at or now_iso()
    errors = validate_sources(sources_doc)
    if errors:
        raise SyncError("sources.json is invalid:\n  - " + "\n  - ".join(errors))

    all_games = sources_doc["games"]
    enabled = [game for game in all_games if game.get("enabled")]
    disabled = [game for game in all_games if not game.get("enabled")]

    started_at = observed_at
    resolved: dict[str, VersionInfo] = {}
    rate_limited = False

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {pool.submit(resolve_version, game, client): game for game in enabled}
        for future in as_completed(futures):
            game = futures[future]
            try:
                resolved[game["gameId"]] = future.result()
            except RateLimitError:
                rate_limited = True
                resolved[game["gameId"]] = VersionInfo("", "", "", "", None, STATUS_ERROR)
            except Exception:  # noqa: BLE001 - isolate a single source failure
                resolved[game["gameId"]] = VersionInfo("", "", "", "", None, STATUS_ERROR)

    entries: list[dict[str, Any]] = []
    new_last_known: dict[str, Any] = {}
    fatal: list[str] = []
    success = 0
    failed = 0

    for game in enabled:
        game_id = game["gameId"]
        version = resolved.get(game_id) or VersionInfo("", "", "", "", None, STATUS_ERROR)
        previous = last_known.get(game_id) if isinstance(last_known, dict) else None
        has_previous = bool(previous and previous.get("version"))

        if version.status != STATUS_OK and not has_previous:
            fatal.append(game_id)

        entry = build_entry(game, version, previous, observed_at)
        entries.append(entry)
        source_state = {
            "version": entry["source"].get("version"),
            "versionType": entry["source"].get("versionType"),
            "versionUrl": entry["source"].get("versionUrl"),
            "revision": entry["source"].get("revision"),
            "publishedAt": entry["source"].get("publishedAt"),
            "observedAt": entry["source"].get("observedAt"),
            "status": entry["source"].get("status"),
        }
        new_last_known[game_id] = source_state
        if entry["source"].get("status") == STATUS_OK:
            success += 1
        else:
            failed += 1

    if rate_limited:
        fatal.append("__rate_limited__")

    data, manifest = generate_catalog(entries, observed_at)
    catalog_errors = validate_catalog(json.loads(data.decode("utf-8")))
    if catalog_errors:
        raise SyncError("generated catalog is invalid:\n  - " + "\n  - ".join(catalog_errors))

    report = {
        "startedAt": started_at,
        "finishedAt": now_iso(),
        "totalSources": len(all_games),
        "enabledSources": len(enabled),
        "disabledSources": len(disabled),
        "success": success,
        "failed": failed,
        "skipped": len(disabled),
        "requests": getattr(client, "requests", None),
        "rateLimitRemaining": getattr(client, "rate_limit_remaining", None),
        "rateLimited": rate_limited,
        "fatal": list(fatal),
        "gameCount": manifest["gameCount"],
        "contentSha256": manifest["contentSha256"],
    }
    return CatalogResult(data=data, manifest=manifest, last_known=new_last_known, report=report, fatal=fatal)


# --------------------------------------------------------------------------- #
# File IO + CLI
# --------------------------------------------------------------------------- #
def run_sync() -> int:
    if not SOURCES_PATH.exists():
        print(f"sources file not found: {SOURCES_PATH}", file=sys.stderr)
        return 1
    sources_doc = load_json(SOURCES_PATH)
    last_known = load_json(LAST_KNOWN_PATH) if LAST_KNOWN_PATH.exists() else {}
    client = GitHubClient(token=os.environ.get("GITHUB_TOKEN"))

    try:
        result = compute_catalog(sources_doc, client, last_known)
    except SyncError as error:
        print(str(error), file=sys.stderr)
        return 1

    if result.fatal:
        print("sync blocked; catalog was not published:", file=sys.stderr)
        for game_id in result.fatal:
            print(f"  - {game_id}", file=sys.stderr)
        write_text(LAST_RUN_PATH, dump_json(result.report))
        return 1

    existing = GAMES_PATH.read_bytes() if GAMES_PATH.exists() else None
    content_changed = existing != result.data

    if content_changed or not MANIFEST_PATH.exists():
        write_text(GAMES_PATH, result.data.decode("utf-8"))
        write_text(MANIFEST_PATH, dump_json(result.manifest))
    write_text(LAST_KNOWN_PATH, dump_json(result.last_known))
    write_text(LAST_RUN_PATH, dump_json(result.report))

    print(dump_json(result.report))
    print(f"contentChanged={content_changed} sha256={result.manifest['contentSha256']}")
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="RecompHub catalog synchronizer")
    parser.add_argument("command", choices=("validate", "sync"))
    args = parser.parse_args(argv)

    if args.command == "validate":
        if not SOURCES_PATH.exists():
            print(f"sources file not found: {SOURCES_PATH}", file=sys.stderr)
            return 1
        errors = validate_sources(load_json(SOURCES_PATH))
        if errors:
            print("sources.json is invalid:", file=sys.stderr)
            for error in errors:
                print(f"  - {error}", file=sys.stderr)
            return 1
        print("sources.json is valid")
        return 0

    return run_sync()


if __name__ == "__main__":
    sys.exit(main())
