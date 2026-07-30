# BEMMP dashboard — on-prem image.
#
# Two stages, because the app and the server need different things. The bundle
# needs Vite and React to build; the server needs neither. serve.mjs and
# build-data.mjs import nothing outside Node's own library, so the runtime stage
# ships no node_modules at all and stays around 60 MB.
#
# What must live outside the image, on volumes:
#   /app/BEMMP DATA    the xlsx exports, replaced whenever SharePoint syncs
#   /app/public/data   the generated artifacts, rewritten by the Refresh button
#
# Both are mounted by docker-compose.yml, so `docker compose up -d --build`
# replaces the code and keeps the data and the key.

# ---------------------------------------------------------------- build ------
FROM node:22-alpine AS build

WORKDIR /app

# Copied first so the dependency layer is cached until the lockfile changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src
COPY shared ./shared

# Produces dist/. The data folder is deliberately not baked in: the server reads
# /data/ straight from public/data at runtime so a refresh needs no rebuild.
RUN npm run build

# -------------------------------------------------------------- runtime ------
FROM node:22-alpine AS runtime

# tini reaps the child process build-data.mjs spawns, so a refresh cannot leave
# zombies behind in a long-running container.
RUN apk add --no-cache tini

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/dist ./dist
COPY scripts ./scripts
COPY shared ./shared
COPY package.json ./
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh

RUN chmod +x /usr/local/bin/entrypoint.sh \
 && mkdir -p "/app/BEMMP DATA" /app/public/data

EXPOSE 4173

# Reports unhealthy while a rebuild is running, which is correct — the data route
# is closed for those few seconds.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4173/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "scripts/serve.mjs", "--port", "4173"]
