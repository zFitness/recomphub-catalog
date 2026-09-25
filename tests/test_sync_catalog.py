"""Tests for the RecompHub catalog synchronizer (tasks 2.4 and 6.1).

Run with::

    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import copy
import importlib.util
import json
import sys
import unittest
import urllib.error
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TESTS_DIR.parent
FIXTURES = TESTS_DIR / "fixtures"

spec = importlib.util.spec_from_file_location(
    "sync_catalog", REPO_ROOT / "scripts" / "sync_catalog.py"
)
sync_catalog = importlib.util.module_from_spec(spec)
sys.modules["sync_catalog"] = sync_catalog
spec.loader.exec_module(sync_catalog)

GitHubError = sync_catalog.GitHubError
RateLimitError = sync_catalog.RateLimitError
VersionInfo = sync_catalog.VersionInfo


def load_fixture(name):
    with (FIXTURES / name).open("r", encoding="utf-8") as handle:
        return json.load(handle)


class FakeClient:
    """Stand-in for GitHubClient that returns fixed observations."""

    def __init__(
        self,
        release=None,
        tags=None,
        commit=None,
        default_branch="main",
        fail=False,
        rate_limited=False,
    ):
        self.release = release
        self.tags = tags or []
        self.commit = commit
        self.default_branch_value = default_branch
        self.fail = fail
        self.rate_limited = rate_limited
        self.requests = 0
        self.rate_limit_remaining = 5000

    def _guard(self):
        self.requests += 1
        if self.rate_limited:
            raise RateLimitError("rate limited")
        if self.fail:
            raise GitHubError("network down")

    def latest_release(self, owner, repo):
        self._guard()
        return self.release

    def list_tags(self, owner, repo):
        self._guard()
        return self.tags

    def get_commit(self, owner, repo, ref):
        self._guard()
        return self.commit

    def default_branch(self, owner, repo):
        self._guard()
        return self.default_branch_value

    def commit_sha_for_ref(self, owner, repo, ref):
        self._guard()
        return (self.commit or {}).get("sha")


def make_client(**kwargs):
    release = kwargs.pop("release", load_fixture("github_release.json"))
    tags = kwargs.pop("tags", load_fixture("github_tags.json"))
    commit = kwargs.pop("commit", load_fixture("github_commit.json"))
    return FakeClient(release=release, tags=tags, commit=commit, **kwargs)


class ValidationTests(unittest.TestCase):
    def test_valid_sources_pass(self):
        self.assertEqual(sync_catalog.validate_sources(load_fixture("sources_valid.json")), [])

    def test_duplicate_game_id_fails(self):
        errors = sync_catalog.validate_sources(load_fixture("sources_duplicate_id.json"))
        self.assertTrue(any("duplicated" in error for error in errors), errors)

    def test_missing_runtime_platform_fails(self):
        errors = sync_catalog.validate_sources(load_fixture("sources_missing_field.json"))
        self.assertTrue(any("runtimePlatforms" in error for error in errors), errors)

    def test_invalid_runtime_platform_fails(self):
        doc = load_fixture("sources_valid.json")
        doc["games"][0]["runtimePlatforms"] = ["dreamcast"]
        errors = sync_catalog.validate_sources(doc)
        self.assertTrue(any("runtimePlatforms" in error for error in errors), errors)

    def test_bad_url_and_strategy_fail(self):
        doc = load_fixture("sources_valid.json")
        doc["games"][0]["projectUrl"] = "ftp://example.com"
        doc["games"][0]["versionStrategy"] = "semver"
        errors = sync_catalog.validate_sources(doc)
        self.assertTrue(any("projectUrl" in error for error in errors), errors)
        self.assertTrue(any("versionStrategy" in error for error in errors), errors)


class ResolutionTests(unittest.TestCase):
    def test_release_strategy(self):
        info = sync_catalog.resolve_version(load_fixture("sources_valid.json")["games"][0], make_client())
        self.assertEqual(info.status, sync_catalog.STATUS_OK)
        self.assertEqual(info.version, "v2.0.1")
        self.assertEqual(info.version_type, "release")
        self.assertEqual(info.revision, "422d7bb1b6c8d973cccf8b3d0b226a57ac3cc8c7")

    def test_release_missing_falls_back_to_tag(self):
        source = load_fixture("sources_valid.json")["games"][0]
        info = sync_catalog.resolve_version(source, make_client(release=None))
        self.assertEqual(info.status, sync_catalog.STATUS_OK)
        self.assertEqual(info.version_type, "tag")
        self.assertEqual(info.version, "v2.0.1")

    def test_release_missing_without_fallback_is_unavailable(self):
        source = load_fixture("sources_valid.json")["games"][0]
        source = copy.deepcopy(source)
        source["fallback"] = []
        info = sync_catalog.resolve_version(source, make_client(release=None))
        self.assertEqual(info.status, sync_catalog.STATUS_UNAVAILABLE)

    def test_tag_pattern_filters(self):
        source = copy.deepcopy(load_fixture("sources_valid.json")["games"][0])
        source["versionStrategy"] = "tag"
        source["fallback"] = []
        source["tagPattern"] = "v2.*"
        info = sync_catalog.resolve_version(source, make_client())
        self.assertEqual(info.version, "v2.0.1")
        # With a non-matching pattern the result is unavailable.
        source["tagPattern"] = "nightly-*"
        info = sync_catalog.resolve_version(source, make_client())
        self.assertEqual(info.status, sync_catalog.STATUS_UNAVAILABLE)

    def test_commit_strategy_uses_default_branch(self):
        source = copy.deepcopy(load_fixture("sources_valid.json")["games"][0])
        source["versionStrategy"] = "commit"
        source["fallback"] = []
        source["github"].pop("branch")
        info = sync_catalog.resolve_version(source, make_client())
        self.assertEqual(info.version_type, "commit")
        self.assertEqual(info.version, "422d7bb")

    def test_transport_error_is_error_status(self):
        source = load_fixture("sources_valid.json")["games"][0]
        info = sync_catalog.resolve_version(source, make_client(fail=True))
        self.assertEqual(info.status, sync_catalog.STATUS_ERROR)

    def test_rate_limit_propagates(self):
        source = load_fixture("sources_valid.json")["games"][0]
        with self.assertRaises(RateLimitError):
            sync_catalog.resolve_version(source, make_client(rate_limited=True))


class GenerationTests(unittest.TestCase):
    def test_manifest_matches_content_hash(self):
        entries = [
            sync_catalog.build_entry(
                load_fixture("sources_valid.json")["games"][0],
                VersionInfo("v2.0.1", "release", "https://example.com", "abc", "2026-09-20T00:36:12Z"),
                None,
                "2026-09-25T00:00:00Z",
            )
        ]
        data, manifest = sync_catalog.generate_catalog(entries, "2026-09-25T00:00:00Z")
        import hashlib

        self.assertEqual(manifest["contentSha256"], hashlib.sha256(data).hexdigest())
        self.assertEqual(manifest["gameCount"], 1)
        self.assertTrue(manifest["catalogRevision"].startswith("sha256-"))

    def test_catalog_sorted_by_game_id(self):
        base = load_fixture("sources_valid.json")["games"][0]
        first = copy.deepcopy(base)
        first["gameId"] = "zzz"
        second = copy.deepcopy(base)
        second["gameId"] = "aaa"
        info = VersionInfo("v1", "release", "u", "r")
        entries = [
            sync_catalog.build_entry(first, info, None, "t"),
            sync_catalog.build_entry(second, info, None, "t"),
        ]
        data, _ = sync_catalog.generate_catalog(entries, "t")
        document = json.loads(data.decode("utf-8"))
        self.assertEqual([g["gameId"] for g in document["games"]], ["aaa", "zzz"])

    def test_duplicate_detected_in_generated_catalog(self):
        errors = sync_catalog.validate_catalog(
            {"games": [{"gameId": "a"}, {"gameId": "a"}]}
        )
        self.assertTrue(any("duplicate" in error for error in errors), errors)

    def test_disabled_source_excluded(self):
        doc = load_fixture("sources_valid.json")
        doc["games"][0]["enabled"] = False
        result = sync_catalog.compute_catalog(doc, make_client(), {}, "2026-09-25T00:00:00Z")
        document = json.loads(result.data.decode("utf-8"))
        self.assertEqual(document["games"], [])
        self.assertEqual(result.report["skipped"], 1)


class SyncFlowTests(unittest.TestCase):
    def test_new_source_unavailable_is_fatal(self):
        source = copy.deepcopy(load_fixture("sources_valid.json")["games"][0])
        source["fallback"] = []
        doc = {"schemaVersion": 1, "games": [source]}
        result = sync_catalog.compute_catalog(doc, make_client(release=None), {}, "2026-09-25T00:00:00Z")
        self.assertIn("dusklight", result.fatal)

    def test_existing_source_failure_keeps_last_known(self):
        doc = load_fixture("sources_valid.json")
        last_known = {
            "dusklight": {
                "version": "v2.0.0",
                "versionType": "release",
                "versionUrl": "https://example.com/v2.0.0",
                "revision": "oldsha",
                "publishedAt": "2026-09-19T00:04:12Z",
                "observedAt": "2026-09-20T00:00:00Z",
                "status": "ok",
            }
        }
        result = sync_catalog.compute_catalog(doc, make_client(fail=True), last_known, "2026-09-25T00:00:00Z")
        self.assertEqual(result.fatal, [])
        document = json.loads(result.data.decode("utf-8"))
        entry = document["games"][0]
        self.assertEqual(entry["source"]["status"], sync_catalog.STATUS_ERROR)
        self.assertEqual(entry["source"]["version"], "v2.0.0")
        self.assertEqual(entry["source"]["observedAt"], "2026-09-20T00:00:00Z")

    def test_no_change_produces_identical_output(self):
        doc = load_fixture("sources_valid.json")
        client = make_client()
        first = sync_catalog.compute_catalog(doc, client, {}, "2026-09-25T00:00:00Z")
        second = sync_catalog.compute_catalog(doc, make_client(), first.last_known, "2026-09-26T00:00:00Z")
        self.assertEqual(first.data, second.data)
        self.assertEqual(first.manifest["contentSha256"], second.manifest["contentSha256"])

    def test_version_change_updates_observed_at(self):
        doc = load_fixture("sources_valid.json")
        first = sync_catalog.compute_catalog(doc, make_client(), {}, "2026-09-25T00:00:00Z")
        new_release = copy.deepcopy(load_fixture("github_release.json"))
        new_release["tag_name"] = "v2.0.2"
        new_release["html_url"] = "https://github.com/TwilitRealm/dusklight/releases/tag/v2.0.2"
        second = sync_catalog.compute_catalog(
            doc, make_client(release=new_release), first.last_known, "2026-09-26T00:00:00Z"
        )
        self.assertNotEqual(first.data, second.data)
        document = json.loads(second.data.decode("utf-8"))
        self.assertEqual(document["games"][0]["source"]["observedAt"], "2026-09-26T00:00:00Z")

    def test_rate_limit_blocks_publication(self):
        doc = load_fixture("sources_valid.json")
        result = sync_catalog.compute_catalog(doc, make_client(rate_limited=True), {}, "2026-09-25T00:00:00Z")
        self.assertIn("__rate_limited__", result.fatal)

    def test_report_contains_run_statistics(self):
        doc = load_fixture("sources_valid.json")
        result = sync_catalog.compute_catalog(doc, make_client(), {}, "2026-09-25T00:00:00Z")
        self.assertEqual(result.report["success"], 1)
        self.assertEqual(result.report["failed"], 0)
        self.assertEqual(result.report["enabledSources"], 1)
        self.assertIn("requests", result.report)


class ClientTransportTests(unittest.TestCase):
    class Response:
        def __init__(self, payload, headers=None):
            self._payload = json.dumps(payload).encode("utf-8")
            self.headers = headers or {}

        def read(self):
            return self._payload

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def test_retry_after_raises_rate_limit(self):
        def opener(request, timeout=None):
            raise urllib.error.HTTPError(
                request.full_url, 403, "Forbidden", {"retry-after": "60"}, None
            )

        client = sync_catalog.GitHubClient(opener=opener, sleeper=lambda _: None)
        with self.assertRaises(RateLimitError):
            client.latest_release("owner", "repo")

    def test_404_returns_none(self):
        def opener(request, timeout=None):
            raise urllib.error.HTTPError(request.full_url, 404, "Not Found", {}, None)

        client = sync_catalog.GitHubClient(opener=opener, sleeper=lambda _: None)
        self.assertIsNone(client.latest_release("owner", "repo"))

    def test_timeout_retries_then_fails(self):
        calls = {"count": 0}

        def opener(request, timeout=None):
            calls["count"] += 1
            raise TimeoutError("timed out")

        client = sync_catalog.GitHubClient(opener=opener, sleeper=lambda _: None, max_retries=2)
        with self.assertRaises(GitHubError):
            client.latest_release("owner", "repo")
        self.assertEqual(calls["count"], 3)

    def test_successful_parsing_and_rate_limit_headers(self):
        def opener(request, timeout=None):
            return ClientTransportTests.Response(
                {"tag_name": "v1"},
                headers={"x-ratelimit-remaining": "4999"},
            )

        client = sync_catalog.GitHubClient(opener=opener, sleeper=lambda _: None)
        self.assertEqual(client.latest_release("owner", "repo")["tag_name"], "v1")
        self.assertEqual(client.rate_limit_remaining, 4999)
        self.assertEqual(client.requests, 1)


if __name__ == "__main__":
    unittest.main()
