# PRONO SPORT — image de production
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

# dépendances (better-sqlite3 : binaires précompilés, fallback build)
COPY package*.json ./
RUN apk add --no-cache --virtual .build python3 make g++ \
  && npm ci --omit=dev \
  && apk del .build

COPY src ./src
COPY public ./public

# la base et le cache vivent dans /app/data (monter un volume)
RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME /app/data

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "src/server.js"]
