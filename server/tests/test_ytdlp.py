"""Tests de `app.core.ytdlp` : normalisation des formats depuis un JSON `yt-dlp -J`."""

from __future__ import annotations

from app.core.ytdlp import build_format_selector, normalize_formats, suggested_filename

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
        # Planche de vignettes : ni audio ni vidéo, n'a rien à faire dans un choix de qualité.
        {
            "format_id": "sb0",
            "ext": "mhtml",
            "protocol": "mhtml",
            "height": 180,
            "width": 320,
            "vcodec": "none",
            "acodec": "none",
        },
        # Format réservé aux comptes YouTube Premium : échoue en « Requested format is not
        # available » sans compte authentifié (ez-dl-b6e).
        {
            "format_id": "616",
            "ext": "mp4",
            "format_note": "Premium",
            "height": 1080,
            "width": 1920,
            "fps": 25,
            "vcodec": "vp09.00.40.08",
            "acodec": "none",
            "tbr": 5784.0,
        },
    ],
}


def test_normalize_formats_prefers_highest_resolution_as_best() -> None:
    """Le meilleur format est le plus haute qualité, même video-only : `build_format_selector`
    lui adjoint l'audio. Préférer un muxé ferait élire un 720p devant un 1080p60."""
    formats, best_format_id = normalize_formats(SAMPLE_INFO)
    assert best_format_id == "248"
    assert formats[0]["format_id"] == "248"


def test_normalize_formats_drops_storyboards_and_premium() -> None:
    """Storyboards (mhtml) et formats « Premium » ne sont pas téléchargeables : ni listés,
    ni élus meilleur format (ez-dl-b6e)."""
    formats, best_format_id = normalize_formats(SAMPLE_INFO)
    listed = {f["format_id"] for f in formats}
    assert "sb0" not in listed
    assert "616" not in listed
    assert best_format_id not in ("sb0", "616")


def test_normalize_formats_returns_none_when_nothing_is_downloadable() -> None:
    """Extraction dégradée ne renvoyant que des storyboards : aucun format exploitable."""
    formats, best_format_id = normalize_formats(
        {"formats": [{"format_id": "sb0", "protocol": "mhtml", "vcodec": "none", "acodec": "none"}]}
    )
    assert formats == []
    assert best_format_id is None


def test_build_format_selector_adds_audio_and_fallbacks() -> None:
    """Un identifiant nu produirait un fichier muet (YouTube est video-only au-delà de
    360p) et échouerait si l'id a disparu depuis le probe."""
    assert build_format_selector("137") == "137+bestaudio/137/bv*+ba/b"


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


def testlast_line_drops_cookie_jar_warnings() -> None:
    """yt-dlp recopie la ligne fautive du cookie-jar dans un avertissement : elle contient
    des cookies en clair et ne doit jamais atteindre `job.error` ni les logs."""
    from app.core.ytdlp import last_line

    # L'avertissement est la DERNIÈRE ligne : sans filtrage, c'est lui qui serait remonté.
    stderr = (
        b"ERROR: [generic] Unable to download webpage\n"
        b"WARNING: skipping cookie file entry due to invalid format: "
        b"'.example.com\\tTRUE\\t/\\tTRUE\\t0\\tauth_token\\ts3cr3t'\n"
    )

    message = last_line(stderr)

    assert "s3cr3t" not in message
    assert message == "ERROR: [generic] Unable to download webpage"


def testlast_line_falls_back_when_only_cookie_warnings() -> None:
    """Si tout le stderr est filtré, on ne remonte rien plutôt qu'une ligne de cookies."""
    from app.core.ytdlp import last_line

    stderr = b"WARNING: skipping cookie file entry due to x: '.example.com\\tauth\\ts3cr3t'\n"

    assert last_line(stderr) == "erreur inconnue"


def testlast_line_is_truncated() -> None:
    """Un stderr verbeux ne doit pas remplir la base ni les logs."""
    from app.core.ytdlp import last_line

    assert len(last_line(b"ERROR: " + b"x" * 5000)) == 500


def testlast_line_prefers_the_error_line_over_a_trailing_hint() -> None:
    """yt-dlp fait suivre son `ERROR:` de conseils : c'est la cause qui doit remonter à l'UI."""
    from app.core.ytdlp import last_line

    stderr = (
        b"ERROR: [youtube] abc123: Requested format is not available\n"
        b"Install a JS runtime; see  https://github.com/yt-dlp/yt-dlp/wiki/EJS  for details\n"
    )

    assert last_line(stderr).startswith("ERROR: [youtube] abc123: Requested format")
