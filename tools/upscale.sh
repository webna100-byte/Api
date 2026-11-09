#!/usr/bin/env bash
# Upscale a video locally (free) with Real-ESRGAN ncnn-vulkan.
# Quality is below native 1080p generation but much better than plain scaling.
# Get the binary: https://github.com/xinntao/Real-ESRGAN/releases (realesrgan-ncnn-vulkan-*.zip)
# Usage: tools/upscale.sh input.mp4 output.mp4 [scale=2]
set -euo pipefail
in="$1"; out="$2"; scale="${3:-2}"
bin="${REALESRGAN_BIN:-realesrgan-ncnn-vulkan}"
command -v "$bin" >/dev/null || { echo "Real-ESRGAN not found. Set REALESRGAN_BIN or add it to PATH." >&2; exit 1; }
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
mkdir -p "$work/in" "$work/out"
fps="$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "$in")"
ffmpeg -loglevel error -i "$in" -qscale:v 1 -qmin 1 "$work/in/%06d.png"
"$bin" -i "$work/in" -o "$work/out" -n realesr-animevideov3 -s "$scale" -f png
ffmpeg -loglevel error -y -framerate "$fps" -i "$work/out/%06d.png" -i "$in" \
  -map 0:v -map 1:a? -c:v libx264 -crf 17 -pix_fmt yuv420p -c:a copy "$out"
echo "Done: $out"
