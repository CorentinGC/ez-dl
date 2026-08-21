"""Tests de `app.core.ytdlp` : normalisation des formats depuis un JSON `yt-dlp -J`."""

from __future__ import annotations

from app.core.ytdlp import normalize_formats, suggested_filename

SAMPLE_INFO = {
    "title": "Ma Vidéo Test",
    "id": "abc123",
    "ext": "mp4",
    "formats": [
        {
            "format_id": "140",
            "ext": "m4a",
            "acodec": "mp4a.40.2",
            "vcodec": "none",
            "tbr": 128.0,
            "filesize": 5_000_000,
        },
        {
            "format_id": "137",
            "ext": "mp4",
            "height": 1080,
            "width": 1920,
            "fps": 30,
            "vcodec": "avc1.640028",
            "acodec": "none",
            "filesize": 100_000_000,
        },
        {
            "format_id": "22",
            "ext": "mp4",
            "height": 720,
            "width": 1280,
            "fps": 30,
            "vcodec": "avc1.64001F",
            "acodec": "mp4a.40.2",
            "filesize": 50_000_000,
        },
        {
            "format_id": "248",
            "ext": "webm",
            "height": 1080,
            "width": 1920,
            "fps": 60,
            "vcodec": "vp9",
            "acodec": "none",
            "filesize": 120_000_000,
        },
    ],
}


def test_normalize_formats_prefers_combined_audio_video_as_best() -> None:
    """Un format déjà combiné (audio+vidéo) doit être préféré à un flux vidéo seul,
    même de résolution supérieure, pour rester lisible sans fusion ffmpeg."""
    formats, best_format_id = normalize_formats(SAMPLE_INFO)
    assert best_format_id == "22"
    assert formats[0]["format_id"] == "22"


def test_normalize_formats_flags_audio_and_video_only() -> None:
    formats, _ = normalize_formats(SAMPLE_INFO)
    by_id = {f["format_id"]: f for f in formats}

    assert by_id["140"]["has_audio"] is True
    assert by_id["140"]["has_video"] is False

    assert by_id["137"]["has_video"] is True
    assert by_id["137"]["has_audio"] is False

    assert by_id["22"]["has_audio"] is True
    assert by_id["22"]["has_video"] is True


def test_normalize_formats_builds_readable_label() -> None:
    formats, _ = normalize_formats(SAMPLE_INFO)
    by_id = {f["format_id"]: f for f in formats}

    label = by_id["22"]["label"]
    assert "720p" in label
    assert "mp4" in label
    assert "avc1+mp4a" in label


def test_normalize_formats_sorts_video_only_by_resolution_then_fps() -> None:
    formats, _ = normalize_formats(SAMPLE_INFO)
    video_only_ids = [f["format_id"] for f in formats if not f["has_audio"]]
    # 248 (1080p60) doit passer avant 137 (1080p30) à résolution égale.
    assert video_only_ids.index("248") < video_only_ids.index("137")


def test_suggested_filename_is_sanitized_and_has_extension() -> None:
    name = suggested_filename(SAMPLE_INFO)
    assert name.endswith(".mp4")
    assert "/" not in name


def test_last_line_drops_cookie_jar_warnings() -> None:
    """yt-dlp recopie la ligne fautive du cookie-jar dans un avertissement : elle contient
    des cookies en clair et ne doit jamais atteindre `job.error` ni les logs."""
    from app.core.ytdlp import _last_line

    # L'avertissement est la DERNIÈRE ligne : sans filtrage, c'est lui qui serait remonté.
    stderr = (
        b"ERROR: [generic] Unable to download webpage\n"
        b"WARNING: skipping cookie file entry due to invalid format: "
        b"'.example.com\\tTRUE\\t/\\tTRUE\\t0\\tauth_token\\ts3cr3t'\n"
    )

    message = _last_line(stderr)

    assert "s3cr3t" not in message
    assert message == "ERROR: [generic] Unable to download webpage"


def test_last_line_falls_back_when_only_cookie_warnings() -> None:
    """Si tout le stderr est filtré, on ne remonte rien plutôt qu'une ligne de cookies."""
    from app.core.ytdlp import _last_line

    stderr = b"WARNING: skipping cookie file entry due to x: '.example.com\\tauth\\ts3cr3t'\n"

    assert _last_line(stderr) == "erreur inconnue"


def test_last_line_is_truncated() -> None:
    """Un stderr verbeux ne doit pas remplir la base ni les logs."""
    from app.core.ytdlp import _last_line

    assert len(_last_line(b"ERROR: " + b"x" * 5000)) == 500
