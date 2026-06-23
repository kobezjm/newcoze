ARG GATEWAY_BASE=boltdiy-agent-gateway:mvp
FROM ${GATEWAY_BASE}

WORKDIR /app

COPY package.json ./
COPY server ./server
COPY public ./public
COPY sandbox ./sandbox

ENV NODE_ENV=production
ENV PORT=5299

CMD ["node", "server/index.js"]
