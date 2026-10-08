# Dunk AI engine — FastAPI supervisor, LangGraph agents, and dunkai-designer.
#
# Build from the REPOSITORY ROOT, because board generation shells out to
# dunkai-designer, which lives beside ai_engine/:
#
#   docker build -f ai_engine/Dockerfile -t dunkai-ai-engine .
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap \
 && rm -rf /var/lib/apt/lists/*

# Node runs dunkai-designer (board generation). Copied from the official image
# rather than installed from a distro repo, so the version is pinned.
COPY --from=node:22-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:22-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /srv

# CPU-only torch keeps the image ~2 GB smaller; the engine never uses a GPU.
COPY ai_engine/requirement.txt ai_engine/requirement.txt
RUN pip install --extra-index-url https://download.pytorch.org/whl/cpu -r ai_engine/requirement.txt

COPY dunkai-designer/package.json dunkai-designer/package-lock.json dunkai-designer/.npmrc dunkai-designer/
RUN cd dunkai-designer && npm ci --omit=dev && npm cache clean --force

COPY dunkai-designer dunkai-designer
COPY ai_engine ai_engine

# uid 1000 matches the backend image's `node` user: in docker-compose both
# write to the shared uploads volume, and differing owners would lock one out.
RUN useradd --create-home --uid 1000 engine \
 && mkdir -p /data/boards /data/uploads/boards /data/cache \
 && chown -R engine:engine /data /srv
USER engine

# Boards are written under /data/boards and served at /uploads/boards/* —
# either from a volume the backend shares, or proxied by the backend from
# GET /api/v1/supervisor/artifacts/*. Keep the last path segment `boards`.
ENV SUPERVISOR_HOST=0.0.0.0 \
    PORT=8000 \
    DESIGNER_OUTPUT_ROOT=/data/boards \
    DUNKAI_CACHE_DIR=/data/cache \
    DUNKAI_DESIGNER_PATH=/srv/dunkai-designer \
    HF_HOME=/data/cache/hf

WORKDIR /srv/ai_engine
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD python -c "import os,urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"8000\")}/health')" || exit 1

CMD ["python", "-m", "agents.supervisor.server"]
