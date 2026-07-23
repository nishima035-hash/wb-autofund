FROM node:24-bookworm-slim

ENV NODE_ENV=production HOST=0.0.0.0 PORT=4173
WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY import-diary.js ./
COPY validate-config.js ./
COPY public ./public
RUN mkdir -p /app/data && chown -R node:node /app

USER node
EXPOSE 4173
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4173/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
