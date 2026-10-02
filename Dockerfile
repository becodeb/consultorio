FROM node:24-alpine

WORKDIR /app

# Static assets only (no npm dependencies — server.mjs uses Node built-ins only).
COPY index.html styles.css app.js server.mjs README.md manifest.webmanifest sw.js ./
COPY icons ./icons

# Cloudflare caches .css/.js for hours after a deploy; index.html carries a `?v=__V__`
# query string on those two asset URLs so each build gets a fresh, cache-busted version.
# index.html itself is served with Cache-Control: no-cache (see server.mjs), so the
# browser always re-checks it and picks up the new asset URLs right away.
RUN sed -i "s/__V__/$(date +%s)/g" index.html

# DATA_DIR is a volume mount point at runtime; pre-create it here so a fresh named volume
# inherits `node`-owned permissions on first use instead of being root-owned and
# unwritable by the unprivileged user this image runs as.
RUN mkdir -p /data && chown -R node:node /data /app

USER node

ENV DATA_DIR=/data
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--no-warnings", "server.mjs"]
