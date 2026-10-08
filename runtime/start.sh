#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."
if ! command -v docker >/dev/null 2>&1; then
  printf 'Install Docker Desktop (macOS/Windows) or Docker Engine (Linux), then run this again.\n'
  exit 1
fi
if ! docker info >/dev/null 2>&1; then printf 'Start Docker, then run this again.\n'; exit 1; fi
if [ ! -f runtime/runtime.env ]; then
  cp runtime/runtime.env.example runtime/runtime.env
  chmod 600 runtime/runtime.env
  printf 'Set DUNKAI_BACKEND_URL in runtime/runtime.env, then run this again.\n'
  exit 1
fi
docker build -f runtime/Dockerfile -t dunkai-runtime:local .
docker run --rm --init --name dunkai-runtime --cpus=2 --memory=4g --pids-limit=256 \
  --cap-drop=ALL --security-opt=no-new-privileges --security-opt=seccomp=unconfined \
  --security-opt=systempaths=unconfined --security-opt=apparmor=unconfined \
  --env-file runtime/runtime.env --mount type=volume,source=dunkai-runtime-data,target=/data dunkai-runtime:local
