# WhatsOnMyNet – container image
# Built by GitHub Actions for linux/amd64 and linux/arm64 (ghcr.io/soleil0815/whatsonmynet)

# Base image pinned by digest (reproducible); Dependabot proposes new digests
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS deps
WORKDIR /app
# Build tools only in case better-sqlite3 finds no prebuilt binary
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# Keep only what runs (one better-sqlite3 binary, no tests/docs of the packages), then check the driver loads
COPY docker/prune-modules.sh /tmp/prune-modules.sh
RUN sh /tmp/prune-modules.sh /app/node_modules \
 && node -e "const D=require('better-sqlite3');console.log('SQLite',new D(':memory:').prepare('select sqlite_version() v').get().v)" \
 && node -e "require('mysql2/promise');require('pg');require('net-snmp');require('ldapts');console.log('drivers ok')"

FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
ARG VERSION=dev
LABEL org.opencontainers.image.title="WhatsOnMyNet" \
      org.opencontainers.image.description="Scan your network, recognise devices automatically and keep only what you want in a clean inventory" \
      org.opencontainers.image.source="https://github.com/soleil0815/whatsonmynet" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.version="${VERSION}"

# openssl: creates the self-signed certificate and reads uploaded .pfx files
# iputils-ping: ICMP echo without root (if the host allows unprivileged ping)
# npm, corepack and yarn of the base image are not needed at runtime – removed (smaller attack surface)
RUN apk add --no-cache tini su-exec tzdata openssl iputils-ping \
 && apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /opt/yarn-v* /usr/local/bin/yarn /usr/local/bin/yarnpkg

WORKDIR /app
ENV NODE_ENV=production \
    WOMN_DATA_DIR=/data

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY docker-compose.yml env.example ./deploy/
COPY docker/entrypoint.sh /usr/local/bin/womn-entrypoint
COPY docker/healthcheck.mjs /app/docker/healthcheck.mjs
# Emergency access: docker compose exec whatsonmynet womn-admin …
COPY docker/womn-admin.sh /usr/local/bin/womn-admin

RUN chmod 0755 /usr/local/bin/womn-entrypoint /usr/local/bin/womn-admin && mkdir -p /data

VOLUME ["/data"]
# HTTPS (8743) and the HTTP port that redirects to it (8780) – both can be changed in .env
EXPOSE 8743 8780
HEALTHCHECK --interval=30s --timeout=6s --start-period=30s --retries=3 \
  CMD node /app/docker/healthcheck.mjs || exit 1

ENTRYPOINT ["/sbin/tini", "--", "womn-entrypoint"]
CMD ["node", "src/server.js"]
