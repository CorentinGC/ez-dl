# Module — Conversion

Conversion is optional and driven by a system of ffmpeg **presets**, detected at server startup
based on the encoders actually available on the machine/container.

## Encoder detection

At startup (`server/app/main.py`, lifespan), the `server/app/core/ffmpeg.py` service runs:

```
ffmpeg -encoders
```

and parses the output to build the list of available encoders. This list is cached in memory for
the lifetime of the process (restart the server if the hardware/drivers change).

`GET /api/capabilities` exposes the result:

```json
{
  "encoders": [{"id": "h264_nvenc", "name": "NVIDIA H.264", "hwaccel": "nvenc", "codec": "h264"}],
  "presets": [{"id": "h264_nvenc", "label": "H.264 (NVIDIA GPU)", "description": "...", "container": "mp4", "video_codec": "h264_nvenc", "args_preview": "-c:v h264_nvenc -preset p4"}]
}
```

**A preset is only offered to the extension if its underlying encoder is detected as available.**
The popup therefore never shows a preset that would be unusable on the target server.

## Provided presets

| Preset | Encoder | Use case |
|---|---|---|
| `copy` | — (remux) | **Default**, always available. No re-encoding: copies the streams as-is into the final container. Fast, lossless, but changes neither codec nor resolution. |
| `h264_nvenc` / `hevc_nvenc` | NVIDIA NVENC | GPU-accelerated re-encoding on machines with an NVIDIA card. |
| `h264_qsv` / `hevc_qsv` | Intel QuickSync | GPU-accelerated re-encoding on Intel CPUs with an iGPU. |
| `h264_vaapi` / `hevc_vaapi` | VAAPI (Linux) | Generic Linux hardware acceleration (Intel/AMD). |
| `libx264` / `libx265` | CPU (x264/x265) | Software re-encoding, no hardware dependency, slower. |
| `audio_mp3` / `audio_opus` | CPU | Audio-only extraction (no video stream in the output). |

Each preset defines: the output container, the video codec (or the absence of a video track for
audio presets), and the associated ffmpeg arguments (`args_preview` exposed for transparency on
the UI side).

## NVENC support in the Docker image

The ffmpeg installed by default in `server/Dockerfile` (Debian package, build arg
`FFMPEG_VARIANT=debian`) does **not** include the NVENC encoders: Debian repositories exclude the
non-free dependencies NVIDIA requires. As a result, even with the GPU passthrough from
`docker-compose.gpu.yml`, `ffmpeg -encoders` won't list `h264_nvenc`/`hevc_nvenc`, and those
presets never show up in `/api/capabilities`.

To enable NVENC, rebuild the server image with the `nvenc` variant: a static
[BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) binary (`linux64-gpl`,
self-contained) replaces the Debian package in the final image. `docker-compose.gpu.yml` sets
this build arg automatically — just (re)build with both compose files:

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build
```

Limitations to be aware of:

- The `nvenc` variant is available **for amd64 only** (BtbN does not publish a `linux64` build
  for arm64) — no practical impact, since NVENC is an NVIDIA-specific technology.
- Requires `nvidia-container-toolkit` on the host, and `NVIDIA_DRIVER_CAPABILITIES` including the
  `video` capability (already set in `docker-compose.gpu.yml`) to expose `libnvidia-encode`
  inside the container.

Implementation details: `ffmpeg-debian` / `ffmpeg-nvenc` stages in `server/Dockerfile`.

## Conversion workflow

1. The job has a `preset_id` different from `copy` (or absent, with a default other than `copy`
   if configured on the extension side).
2. After the download completes (`status: downloading` → done), the queue worker invokes
   `server/app/core/ffmpeg.py` with the temporary file as input, an output file in
   `EZDL_TEMP_DIR`, and the preset's arguments.
3. `status: converting` is published via SSE during execution.
4. At the end, the converted file replaces the downloaded file for the `moving` step (move to
   `folder`, revalidated against `EZDL_DOWNLOAD_ROOTS`).
5. On ffmpeg failure (encoder unavailable at execution time, corrupted stream, etc.) →
   `status: error`, temporary files cleaned up.

As with yt-dlp, every call to ffmpeg goes through `subprocess` with an **argument list**, never
`shell=True` (see [conventions.md](../conventions.md#security)).

## Adding a preset

1. Define the preset in `server/app/core/ffmpeg.py`: id, label, description, container, video
   codec (or `None` for an audio-only preset), list of ffmpeg arguments, and the id of the
   required ffmpeg encoder (used to filter via `ffmpeg -encoders`).
2. Check that the chosen container is compatible with the codec (e.g. do not offer H.265 in a
   container that common target players don't support).
3. Add a test case in `server/tests/test_capabilities.py`: preset absent if the encoder is not in
   the simulated output of `ffmpeg -encoders`, present otherwise.
4. Document the preset in the table above (and its mirror in `docs/en/modules/conversion.md`).
5. No change required on the extension side: the list of presets is entirely driven by
   `GET /api/capabilities`; the popup displays it dynamically.
