"""Tests du probe yt-dlp : arguments, règle playlist, route (422), coalescing, annulation."""

from __future__ import annotations

import asyncio
import json
import os
import time

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

import app.core.ytdlp as ytdlp
from app.config import Settings
from app.core.probe_cache import ClientDisconnectedError, ProbeCoordinator, coordinator
from app.core.process import redact_credentials, run_bounded
from app.schemas import ProbeRequest, RuleCreate
from tests.conftest import _stub_external_binaries

AUTH = {"Authorization": "Bearer test-secret"}
VIDEO = {
    "title": "Clip",
    "id": "abc",
    "ext": "mp4",
    "formats": [
        {"format_id": "22", "ext": "mp4", "height": 720, "vcodec": "avc1", "acodec": "aac"}
    ],
}


@pytest.fixture(autouse=True)
def _reset_coordinator():
    coordinator.reset()
    yield
    coordinator.reset()


def _fake_run_bounded(monkeypatch, payload: dict) -> list[tuple[str, ...]]:
    """Remplace `run_bounded` du module ytdlp ; retourne la liste des argv reçus."""
    calls: list[tuple[str, ...]] = []

    async def fake(*args: str, timeout: float, **_kw: object):
        calls.append(args)
        return 0, json.dumps(payload).encode(), b""

    monkeypatch.setattr(ytdlp, "run_bounded", fake)
    return calls


async def test_probe_without_playlist_items_is_flat_and_single(monkeypatch) -> None:
    calls = _fake_run_bounded(monkeypatch, VIDEO)
    await ytdlp.probe("https://example.com/v", proxy="http://gluetun:8888")
    args = list(calls[0])
    assert "--no-playlist" in args
    assert "--flat-playlist" in args
    assert args[args.index("--playlist-items") + 1] == "1"
    # `--proxy` doit précéder le séparateur `--`, l'URL le suit.
    assert args.index("--proxy") < args.index("--")
    assert args[-2:] == ["--", "https://example.com/v"]


async def test_probe_with_playlist_items_is_not_flat(monkeypatch) -> None:
    calls = _fake_run_bounded(monkeypatch, VIDEO)
    await ytdlp.probe("https://example.com/v", playlist_items=3)
    args = list(calls[0])
    assert "--flat-playlist" not in args
    assert "--no-playlist" in args
    assert args[args.index("--playlist-items") + 1] == "3"
    assert "--proxy" not in args


async def test_probe_listing_raises_dedicated_error(monkeypatch) -> None:
    _fake_run_bounded(monkeypatch, {"_type": "playlist", "entries": [VIDEO]})
    with pytest.raises(ytdlp.YtDlpListingError):
        await ytdlp.probe("https://example.com/search")


async def test_probe_unwraps_first_entry_with_playlist_items(monkeypatch) -> None:
    entry = {**VIDEO, "title": "Entrée 2"}
    _fake_run_bounded(
        monkeypatch, {"_type": "playlist", "title": "Liste", "entries": [None, entry]}
    )
    info = await ytdlp.probe("https://example.com/tweet", playlist_items=2)
    assert info["title"] == "Entrée 2"
    assert info["best_format_id"] == "22"


async def test_probe_invalid_json_is_ytdlp_error(monkeypatch) -> None:
    async def fake(*_a: str, timeout: float, **_kw: object):
        return 0, b"pas du json", b""

    monkeypatch.setattr(ytdlp, "run_bounded", fake)
    with pytest.raises(ytdlp.YtDlpError):
        await ytdlp.probe("https://example.com/v")


async def test_start_download_args(monkeypatch) -> None:
    captured: list[tuple[str, ...]] = []

    async def fake_spawn(*args: str, **_kw: object):
        captured.append(args)

    monkeypatch.setattr(ytdlp, "spawn", fake_spawn)
    await ytdlp.start_download(
        "https://example.com/v", ytdlp.Path("/tmp/x/download.%(ext)s"), proxy="socks5h://p:1080"
    )
    args = list(captured[0])
    assert "--no-playlist" in args
    assert "--flat-playlist" not in args
    assert args[args.index("--playlist-items") + 1] == "1"
    assert args.index("--proxy") < args.index("--")


def test_route_listing_returns_422(client, monkeypatch) -> None:
    _fake_run_bounded(monkeypatch, {"_type": "playlist", "entries": [VIDEO]})
    response = client.post("/api/probe", json={"url": "https://example.com/s"}, headers=AUTH)
    assert response.status_code == 422
    assert "ouvrez une vidéo" in response.json()["detail"]


def test_route_forwards_playlist_items_on_get(client, monkeypatch) -> None:
    calls = _fake_run_bounded(monkeypatch, VIDEO)
    response = client.get("/api/probe?url=https://example.com/v&playlist_items=2", headers=AUTH)
    assert response.status_code == 200
    assert "--flat-playlist" not in calls[0]


async def test_run_bounded_kills_whole_group_on_timeout(tmp_path) -> None:
    pid_file = tmp_path / "child.pid"
    script = f"sleep 30 & echo $! > {pid_file}; sleep 30"
    with pytest.raises(TimeoutError):
        await run_bounded("sh", "-c", script, timeout=1.0)
    child_pid = int(pid_file.read_text())
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        try:
            os.kill(child_pid, 0)
        except ProcessLookupError:
            return
        await asyncio.sleep(0.1)
    pytest.fail("le process enfant a survécu au timeout")


async def _never_disconnected() -> bool:
    return False


async def test_coordinator_coalesces_identical_probes_and_caches() -> None:
    coord = ProbeCoordinator()
    calls = 0

    async def factory() -> dict:
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.05)
        return {"ok": True}

    first, second = await asyncio.gather(
        coord.run("k", factory, _never_disconnected), coord.run("k", factory, _never_disconnected)
    )
    assert first == second == {"ok": True}
    assert calls == 1
    await coord.run("k", factory, _never_disconnected)  # servi par le cache
    assert calls == 1


async def test_coordinator_does_not_cache_failures() -> None:
    coord = ProbeCoordinator()
    calls = 0

    async def factory() -> dict:
        nonlocal calls
        calls += 1
        raise ytdlp.YtDlpError("boom")

    for _ in range(2):
        with pytest.raises(ytdlp.YtDlpError):
            await coord.run("k", factory, _never_disconnected)
    assert calls == 2


async def test_coordinator_cancels_probe_when_last_waiter_disconnects() -> None:
    coord = ProbeCoordinator()
    was_cancelled = asyncio.Event()

    async def factory() -> dict:
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            was_cancelled.set()
            raise
        return {}

    async def disconnected() -> bool:
        return True

    with pytest.raises(ClientDisconnectedError):
        await coord.run("k", factory, disconnected)
    await asyncio.wait_for(was_cancelled.wait(), timeout=2)


async def test_coordinator_keeps_probe_while_another_waiter_remains() -> None:
    coord = ProbeCoordinator()

    async def factory() -> dict:
        await asyncio.sleep(0.2)
        return {"ok": 1}

    async def disconnected() -> bool:
        return True

    stay = asyncio.create_task(coord.run("k", factory, _never_disconnected))
    await asyncio.sleep(0.05)
    with pytest.raises(ClientDisconnectedError):
        await coord.run("k", factory, disconnected)
    assert await stay == {"ok": 1}


@pytest.mark.parametrize(
    "value", ["http://gluetun:8888", "socks5h://u:p@host:1080", "socks5://h", ""]
)
def test_proxy_setting_accepts_valid(value, base_env) -> None:
    assert Settings(proxy=value).proxy == value


@pytest.mark.parametrize(
    "value",
    [
        "gluetun:8888",
        "ftp://host",
        "http://",
        "socks4://h",
        "http://user:secret@",
        "http://user:secret@127.0.0.1:abc",
        "http://user:secret@host:99999",
        "http://user:sec ret@host:8888",
        "http://user:secret@host:8888/\x00",
    ],
)
def test_proxy_setting_rejects_invalid_without_leaking(value) -> None:
    with pytest.raises(ValidationError) as exc_info:
        Settings(proxy=value)
    assert "secret" not in str(exc_info.value)


def test_capabilities_proxy_enabled(base_env, monkeypatch) -> None:
    from app.main import create_app

    _stub_external_binaries(monkeypatch)
    monkeypatch.setenv("EZDL_PROXY", "http://user:pass@gluetun:8888")
    from app.config import get_settings

    get_settings.cache_clear()
    with TestClient(create_app()) as proxied:
        body = proxied.get("/api/capabilities", headers=AUTH).json()
    assert body["proxy_enabled"] is True
    assert "pass" not in json.dumps(body)


def test_capabilities_proxy_disabled_by_default(client) -> None:
    assert client.get("/api/capabilities", headers=AUTH).json()["proxy_enabled"] is False


@pytest.mark.parametrize(
    "payload",
    [
        {"referer": "https://a.example/\r\nX: 1"},
        {"headers": {"X-Test": "a\nb"}},
        {"headers": {"X\x00": "v"}},
        {"headers": {"Bad:Name": "v"}},
        {"referer": "https://a.example/" + "a" * 3000},
    ],
)
def test_probe_request_rejects_control_chars_and_long_values(payload) -> None:
    with pytest.raises(ValidationError):
        ProbeRequest(url="https://example.com/v", **payload)


@pytest.mark.parametrize(
    "domain", ["localhost", "http://example.com", "a b.com", "ex.com/path", "x" * 260 + ".com"]
)
def test_rule_rejects_invalid_domain(domain) -> None:
    with pytest.raises(ValidationError):
        RuleCreate(domain=domain, url_pattern="*")


def test_rule_accepts_valid_domain_and_bounds_pattern() -> None:
    assert RuleCreate(domain="cdn.example.com", url_pattern="*.m3u8").domain == "cdn.example.com"
    with pytest.raises(ValidationError):
        RuleCreate(domain="example.com", url_pattern="a" * 501)


def test_error_line_never_carries_proxy_credentials() -> None:
    raw = b"ERROR: Failed to parse: http://user:secretpw@127.0.0.1:abc\n"
    line = ytdlp.last_line(raw)
    assert "secretpw" not in line
    assert "http://***@127.0.0.1:abc" in line


def test_redact_credentials_keeps_urls_without_userinfo() -> None:
    assert redact_credentials("GET https://example.com/a@b") == "GET https://example.com/a@b"
    assert redact_credentials("socks5h://u:p@h:1080 x") == "socks5h://***@h:1080 x"


async def test_new_requester_does_not_join_a_cancelling_probe() -> None:
    coord = ProbeCoordinator()
    calls = 0

    async def factory() -> dict:
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.1)
        return {"call": calls}

    async def disconnected() -> bool:
        return True

    with pytest.raises(ClientDisconnectedError):
        await coord.run("k", factory, disconnected)
    # La première tâche est en cours d'annulation : le nouveau demandeur en relance une.
    assert await coord.run("k", factory, _never_disconnected) == {"call": 2}
