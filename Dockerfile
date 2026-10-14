FROM node:22-bookworm-slim

# Install system dependencies including FFMPEG
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source code and static frontend
COPY server/ ./server/
COPY public/ ./public/

# Create data directory for cache and thumbnails
RUN mkdir -p /app/data /app/data/thumbnails

# Cloud Run defaults
ENV PORT=8080
ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "server/index.js"]
