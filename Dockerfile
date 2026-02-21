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

# Credentials file will be mounted at runtime (e.g. Secret Manager or volume)
# Default path inside container
ENV CREDENTIALS_PATH=/app/linkedin-credentials.json
ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

# Run as non-root (Playwright image supports pwuser)
USER pwuser
CMD ["node", "dist/server.js"]
