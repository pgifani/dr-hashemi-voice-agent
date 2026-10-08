# Persian voice receptionist (prototype) — zero npm dependencies.
FROM node:22-alpine

WORKDIR /app

# App source (exclusions live in .dockerignore)
COPY . .

ENV PORT=3100
EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3100/healthz >/dev/null 2>&1 || exit 1

CMD ["node", "server.mjs"]
