# Opumia renderer: Node 22 + FFmpeg + headless Chromium deps. Build context = repo root (see wrangler.toml).
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates fonts-liberation fonts-dejavu-core fonts-noto-core \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
      libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile

# Pre-fetch Remotion's headless Chrome into the image (no download at render time).
RUN cd packages/motion-engine && node --input-type=module -e "import { ensureBrowser } from '@remotion/renderer'; await ensureBrowser();"

ENV NODE_ENV=production OPUMIA_ROOT=/work PORT=8080
RUN mkdir -p /work/data /work/out /work/Library /work/Reference
EXPOSE 8080
CMD ["npx", "tsx", "apps/container/src/server.ts"]
