# Build from the repository root, or the extracted runtime download.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node:22-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:22-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 NODE_ENV=production
WORKDIR /srv
COPY ai_engine/requirements.txt ai_engine/requirements.txt
# Install CPU torch explicitly: an extra index can select a CUDA wheel.
RUN pip install --index-url https://download.pytorch.org/whl/cpu 'torch>=2.2.0' \
 && pip install -r ai_engine/requirements.txt
COPY dunkai-designer/package.json dunkai-designer/package-lock.json dunkai-designer/.npmrc dunkai-designer/
RUN cd dunkai-designer && npm ci --omit=dev && npm cache clean --force
COPY dunkai-designer/src dunkai-designer/src
COPY ai_engine/agents ai_engine/agents
COPY ai_engine/data/profiles /data/engine-data/profiles
COPY runtime/src runtime/src
RUN useradd --create-home --uid 1000 engine \
 && mkdir -p /data/boards /data/cache /data/runtime /data/engine-data \
 && ln -s /data/engine-data /srv/ai_engine/data \
 && chown -R engine:engine /data
USER engine
ENV DESIGNER_OUTPUT_ROOT=/data/boards DUNKAI_CACHE_DIR=/data/cache \
    DUNKAI_DESIGNER_PATH=/srv/dunkai-designer HF_HOME=/data/cache/hf \
    DUNKAI_ENGINE_PATH=/srv/ai_engine DUNKAI_STATE_DIR=/data/runtime \
    BOARD_SANDBOX_REQUIRED=true SUPERVISOR_HOST=127.0.0.1 PORT=8000
# No published port: all connections to the hosted API are outbound.
WORKDIR /srv/ai_engine
CMD ["node", "/srv/runtime/src/cli.mjs"]
