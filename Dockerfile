FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY seed-db.js ./
COPY api-data.json ./
COPY .env.example ./
COPY substrata-field ./substrata-field

ENV NODE_ENV=production
ENV PORT=3002

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3002/api/health || exit 1

CMD ["node", "server.js"]
