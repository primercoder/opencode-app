#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODELS="$ROOT/dev-models"
PROXY="${HTTPS_PROXY:-${https_proxy:-}}"
CURL_ARGS=(-L --fail --retry 3 --show-error)

if [[ -n "$PROXY" ]]; then
  CURL_ARGS+=(--proxy "$PROXY")
fi

fetch() {
  local path="$1" url="$2" expected="$3"
  local dest="$MODELS/$path"
  if [[ -f "$dest" ]] && [[ "$(sha256sum "$dest" | cut -d' ' -f1)" == "$expected" ]]; then
    echo "ok $path"
    return
  fi
  mkdir -p "$(dirname "$dest")"
  echo "downloading $path"
  curl "${CURL_ARGS[@]}" -o "$dest.part" "$url"
  local actual
  actual="$(sha256sum "$dest.part" | cut -d' ' -f1)"
  if [[ "$actual" != "$expected" ]]; then
    echo "sha256 mismatch for $path: $actual" >&2
    rm -f "$dest.part"
    exit 1
  fi
  mv "$dest.part" "$dest"
}

fetch \
  "whisper/ggml-base-q5_1.bin" \
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin" \
  "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898"

fetch \
  "sherpa/sense-voice.tar.bz2" \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2" \
  "7305f7905bfcf77fa0b39388a313f3da35c68d971661a65475b56fb2162c8e63"

echo "models ready in $MODELS"
