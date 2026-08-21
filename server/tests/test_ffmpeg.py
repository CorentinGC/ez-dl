"""Tests de `app.core.ffmpeg` : parsing de `ffmpeg -encoders` et presets disponibles."""

from __future__ import annotations

from app.core.ffmpeg import available_presets, parse_encoders, relevant_encoders

ENCODERS_WITH_NVENC = """Encoders:
 V..... = Video
 A..... = Audio
 S..... = Subtitle
 .F.... = Frame-level multithreading
 ..S... = Slice-level multithreading
 ...X.. = Codec is experimental
 ....B. = Supports draw_horiz_band
 .....D = Supports direct rendering method 1
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V....D libx265              libx265 H.265 / HEVC (codec hevc)
 V..... h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
 V..... hevc_nvenc           NVIDIA NVENC hevc encoder (codec hevc)
 A..... libmp3lame           libmp3lame MP3 (MPEG audio layer 3)
 A..... libopus              libopus Opus
"""

ENCODERS_WITHOUT_NVENC = """Encoders:
 V..... = Video
 A..... = Audio
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V....D libx265              libx265 H.265 / HEVC (codec hevc)
 A..... libmp3lame           libmp3lame MP3 (MPEG audio layer 3)
 A..... libopus              libopus Opus
"""


def test_parse_encoders_ignores_header_and_extracts_known_encoders() -> None:
    encoders = parse_encoders(ENCODERS_WITH_NVENC)

    assert "=" not in encoders
    assert "libx264" in encoders
    assert "h264_nvenc" in encoders
    assert encoders["h264_nvenc"].hwaccel == "nvidia"
    assert encoders["h264_nvenc"].codec == "h264"
    assert encoders["libx264"].hwaccel is None


def test_available_presets_includes_nvenc_when_present() -> None:
    encoders = parse_encoders(ENCODERS_WITH_NVENC)
    ids = {p.id for p in available_presets(encoders)}

    assert "copy" in ids
    assert "h264_nvenc" in ids
    assert "hevc_nvenc" in ids
    assert "libx264" in ids
    assert "audio_mp3" in ids
    assert "h264_qsv" not in ids


def test_available_presets_excludes_nvenc_when_absent() -> None:
    encoders = parse_encoders(ENCODERS_WITHOUT_NVENC)
    ids = {p.id for p in available_presets(encoders)}

    assert "copy" in ids
    assert "libx264" in ids
    assert "h264_nvenc" not in ids
    assert "hevc_nvenc" not in ids


def test_copy_preset_always_available_even_with_no_encoders() -> None:
    ids = {p.id for p in available_presets({})}
    assert ids == {"copy"}


ENCODERS_NOISY = """Encoders:
 V..... = Video
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V..... hevc_videotoolbox    VideoToolbox H.265 Encoder (codec hevc)
 V..... a64multi             Multicolor charset for Commodore 64 (codec a64_multi)
 V..... alias_pix            Alias/Wavefront PIX image
 A..... pcm_s16le            PCM signed 16-bit little-endian
 S..... webvtt               WebVTT subtitle
"""


def test_relevant_encoders_filters_out_image_subtitle_and_pcm_encoders() -> None:
    """Le client ne doit recevoir que des encodeurs exploitables pour la conversion."""
    ids = {e.id for e in relevant_encoders(parse_encoders(ENCODERS_NOISY))}

    assert ids == {"libx264", "hevc_videotoolbox"}


def test_videotoolbox_is_detected_as_hardware_and_offered_as_preset() -> None:
    encoders = parse_encoders(ENCODERS_NOISY)

    assert encoders["hevc_videotoolbox"].hwaccel == "videotoolbox"
    assert "hevc_videotoolbox" in {p.id for p in available_presets(encoders)}
