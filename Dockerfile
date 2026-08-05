# Веб-приложение lp-monitor (node + tsx)
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
ENV PORT=3000
EXPOSE 3000
CMD ["npx", "tsx", "src/server.ts"]
