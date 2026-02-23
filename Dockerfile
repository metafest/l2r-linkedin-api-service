# Use Playwright's official image (Node + Chromium and deps preinstalled)
FROM mcr.microsoft.com/playwright:v1.58.2-noble AS base
WORKDIR /app

# Install all deps (including devDependencies for tsc build)
COPY package*.json ./
RUN npm ci

# Build TypeScript
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Production stage
FROM mcr.microsoft.com/playwright:v1.58.2-noble
WORKDIR /app

# Copy package files and built output; install prod deps only
COPY --from=base /app/package*.json ./
COPY --from=base /app/dist ./dist
RUN npm ci --omit=dev

# Entrypoint: on Cloud Run, copies read-only secret into writable volume
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

# Credentials path: default or set at runtime (writable path when using CREDENTIALS_SOURCE)
ENV CREDENTIALS_PATH=/app/linkedin-credentials.json
ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

# Entrypoint runs as root to copy secret and chown; it then execs as pwuser (see entrypoint.sh)
ENTRYPOINT ["./entrypoint.sh"]
CMD ["node", "dist/server.js"]
