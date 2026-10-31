FROM node:22-bookworm-slim

# Install system dependencies and modern static FFMPEG (with SVT-AV1 v2+/v3+ & x265)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    xz-utils \
    && ARCH="$(uname -m)" \
    && if [ "$ARCH" = "x86_64" ] && curl -fsSL "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz" -o /tmp/ffmpeg.tar.xz; then \
         mkdir -p /tmp/ffmpeg-extract && \
         tar -xJf /tmp/ffmpeg.tar.xz -C /tmp/ffmpeg-extract --strip-components=1 && \
         cp /tmp/ffmpeg-extract/bin/ffmpeg /usr/local/bin/ffmpeg && \
         cp /tmp/ffmpeg-extract/bin/ffprobe /usr/local/bin/ffprobe && \
         chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe && \
         rm -rf /tmp/ffmpeg.tar.xz /tmp/ffmpeg-extract; \
       else \
         apt-get install -y --no-install-recommends ffmpeg; \
       fi \
    && apt-get purge -y --auto-remove curl xz-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source code and static frontend
COPY server/ ./server/
COPY public/ ./public/

# Create data directory for cache, thumbnails, and subtitles
RUN mkdir -p /app/data /app/data/thumbnails /app/data/subtitles

# Cloud Run defaults
ENV PORT=8080
ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "server/index.js"]
