# AperioPlan – Server und Web-Oberfläche in einem Abbild (amd64 und arm64)
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile
COPY shared shared
COPY server server
COPY web web
COPY tsconfig.base.json ./
RUN pnpm --filter ./server build && pnpm --filter ./web build \
 && pnpm --filter ./server deploy --prod --legacy /out

FROM node:22-alpine
RUN apk add --no-cache tini wget
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/web/dist ./web
ENV NODE_ENV=production \
    PORT=3000 \
    WEB_DIST=/app/web \
    STORAGE_ROOT=/data/files \
    BACKUP_DIR=/backups
VOLUME ["/data/files", "/backups"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
