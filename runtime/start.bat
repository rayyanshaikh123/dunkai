@echo off
cd /d "%~dp0.."
docker info >nul 2>&1
if errorlevel 1 (
  echo Install and start Docker Desktop in Linux container mode, then run this again.
  pause
  exit /b 1
)
if not exist runtime\runtime.env (
  copy runtime\runtime.env.example runtime\runtime.env >nul
  echo Set DUNKAI_BACKEND_URL in runtime\runtime.env, then run this again.
  notepad runtime\runtime.env
  pause
  exit /b 1
)
docker build -f runtime/Dockerfile -t dunkai-runtime:local .
if errorlevel 1 (
  pause
  exit /b 1
)
docker run --rm --init --name dunkai-runtime --cpus=2 --memory=4g --pids-limit=256 --cap-drop=ALL --security-opt=no-new-privileges --security-opt=seccomp=unconfined --security-opt=systempaths=unconfined --security-opt=apparmor=unconfined --env-file runtime\runtime.env --mount type=volume,source=dunkai-runtime-data,target=/data dunkai-runtime:local
pause
