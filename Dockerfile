FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit
COPY server ./server
COPY dist ./dist
RUN mkdir /app/data && chown -R node:node /app
USER node
ENV HOST=0.0.0.0 PORT=4200 DB_PATH=/app/data/ichat.sqlite
EXPOSE 4200
VOLUME ["/app/data"]
CMD ["node", "server/index.mjs"]
