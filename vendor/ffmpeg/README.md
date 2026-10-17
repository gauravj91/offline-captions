# Bundled ffmpeg (not in git)

Put an **LGPL** ffmpeg + ffprobe build here before running `npm run dist:mac` / `dist:win`:

```
vendor/ffmpeg/darwin-arm64/ffmpeg, ffprobe
vendor/ffmpeg/darwin-x64/ffmpeg, ffprobe
vendor/ffmpeg/win32-x64/ffmpeg.exe, ffprobe.exe
```

It must include libass, freetype, harfbuzz and an H.264 encoder. Note that libx264 (what `src/render.mjs` uses today)
makes the build GPL. For an LGPL-only build use `h264_videotoolbox` (macOS) / `h264_mf` (Windows) instead of libx264 (needs a small change in
`src/render.mjs`), or ship a GPL build and comply with the GPL. Decide before launch.

electron-builder copies the folder for the target platform to `<resources>/ffmpeg/`; `app/tools.mjs` finds it there and
sets `FFMPEG_PATH` / `FFPROBE_PATH` for the engine worker (the same variables `src/ffmpeg.mjs` already reads).
In development the same folder is checked first, then Homebrew paths (macOS), then `PATH`.
