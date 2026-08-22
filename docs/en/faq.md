# FAQ

## Detection

**A site isn't detected?**
Open the popup, click "Help detect", then click the video on the page. ez-dl correlates that click
with recent network traffic and can save a reusable rule for that site. See
[modules/apprentissage.md](modules/apprentissage.md).

**Does it work with x.com / Twitter?**
Yes, through yt-dlp. Enable cookie forwarding in the options if the content requires a logged-in
session.

**What about DRM-protected services (Netflix, …)?**
No, and it never will — see *Legal & scope* in the [README](../../README.md#legal--scope). That's
explicitly out of scope.

## Server

**Why is a password mandatory?**
The API triggers downloads and writes files to disk. Without authentication, anyone able to reach
the server on your network could start downloads or fill your storage. If `EZDL_PASSWORD` is not
set, the server generates one at **every** startup and prints it in the logs: setting it in `.env`
gives you a stable password.

**Downloaded files are owned by the wrong user.**
Set `PUID`/`PGID` to the owner of the mounted volumes — see
[setup.md](setup.md#runtime-identity-puid--pgid). It's a runtime setting: no image rebuild needed.

**What's the difference between the `latest` and `edge` tags?**
`latest`, `X.Y.Z` and `X.Y` follow published releases (a semver git tag). `edge` and `main-<sha>`
follow every green commit on `main`, with no release notes and no guarantee. A deployment belongs
on `latest`. See [ADR 0006](decisions/0006-versionnement-et-canaux-de-publication.md).

**The server doesn't update itself.**
Two mutually exclusive paths: the watchtower service in the compose file
(`COMPOSE_PROFILES=autoupdate`, recommended), or `deploy/auto-update.sh` from host cron for
installations that build locally. See [setup.md](setup.md#automatic-server-updates).

**NVENC doesn't work even though the GPU is passed to the container.**
GPU passthrough isn't enough: the Debian-packaged ffmpeg doesn't include NVENC. You need the
`FFMPEG_VARIANT=nvenc` image variant (local build, amd64 only) — see
[modules/conversion.md](modules/conversion.md#nvenc-support-in-the-docker-image).

## Extension

**Chrome disables or forgets the extension on restart.**
An unpacked extension is read again from its folder every time Chrome starts: that folder must
stay in place. To avoid Developer mode, use the system-policy installation — see
[setup.md](setup.md#path-without-developer-mode--system-policy-installation).

**A banner announces a new extension version.**
The server publishes the extension bundled in its image: after a server update, the zip on
`/extension` can be newer than the extension loaded in Chrome. Replace it and reload the
extension — see [setup.md](setup.md#republishing-the-extension).
