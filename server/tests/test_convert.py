"""`run_conversion` : options ffmpeg non interactives, échec lisible, annulation."""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.core import convert
from app.core.ffmpeg import Preset

_PRESET = Preset("copy", "Copie", "", "mkv", None, None)


class _FakeFfmpeg:
    def __init__(self, returncode: int, stderr: bytes = b"") -> None:
        self.returncode = returncode
        self._stderr = stderr
        self.pid = -1

    async def communicate(self) -> tuple[bytes, bytes]:
        return b"", self._stderr

    def send_signal(self, sig: int) -> None:
        self.returncode = -int(sig)

    async def wait(self) -> int:
        return self.returncode


async def test_ffmpeg_runs_quiet_and_never_reads_stdin(monkeypatch) -> None:
    calls: list[tuple[tuple[str, ...], dict]] = []

    async def fake_spawn(*args: str, **kwargs: object):
        calls.append((args, kwargs))
        return _FakeFfmpeg(0)

    monkeypatch.setattr(convert, "spawn", fake_spawn)
    started: list[object] = []

    await convert.run_conversion("ffmpeg", _PRESET, Path("in.mp4"), Path("out.mkv"), started.append)

    args, kwargs = calls[0]
    assert args[0] == "ffmpeg"
    assert args[1:4] == ("-nostdin", "-hide_banner", "-loglevel")
    assert args.index("-nostdin") < args.index("-i")
    assert "stdin" not in kwargs  # `spawn` ferme stdin (DEVNULL) par défaut
    assert len(started) == 1


async def test_ffmpeg_failure_reports_the_stderr_tail(monkeypatch) -> None:
    async def fake_spawn(*args: str, **kwargs: object):
        return _FakeFfmpeg(1, b"Invalid data found")

    monkeypatch.setattr(convert, "spawn", fake_spawn)

    with pytest.raises(RuntimeError, match="Invalid data found"):
        await convert.run_conversion("ffmpeg", _PRESET, Path("i"), Path("o"), lambda p: None)


async def test_cancelling_a_conversion_kills_the_process(monkeypatch) -> None:
    process = SimpleNamespace()
    reaped: list[object] = []

    async def hang() -> tuple[bytes, bytes]:
        await asyncio.sleep(60)
        return b"", b""

    process.communicate = hang

    async def fake_spawn(*args: str, **kwargs: object):
        return process

    async def fake_kill(proc: object) -> None:
        reaped.append(proc)

    monkeypatch.setattr(convert, "spawn", fake_spawn)
    monkeypatch.setattr(convert, "kill_and_reap", fake_kill)
    task = asyncio.create_task(
        convert.run_conversion("ffmpeg", _PRESET, Path("i"), Path("o"), lambda p: None)
    )
    await asyncio.sleep(0.05)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)

    assert reaped == [process]
