FROM node:20-alpine
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --ignore-scripts

COPY src/ ./src/

EXPOSE 3002
HEALTHCHECK --interval=15s --timeout=10s --retries=5 \
  CMD wget -qO- http://0.0.0.0:3002/health || exit 1

CMD ["node", "src/index.js"]
