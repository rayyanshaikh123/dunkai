# Dunk AI backend — Express API + Socket.io
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

# Uploaded files and generated boards. Mount a volume here: container disks
# are wiped on redeploy.
RUN mkdir -p /app/uploads && chown -R node:node /app
USER node

ENV PORT=4000 UPLOAD_DIR=/app/uploads
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:${PORT}/health >/dev/null || exit 1

CMD ["node", "src/server.js"]
