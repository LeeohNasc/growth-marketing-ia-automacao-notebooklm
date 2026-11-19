# Worker ReelsFlow — processo contínuo (não roda na Vercel). Build a partir da raiz do monorepo:
#   docker build -f apps/worker/Dockerfile -t reelsflow-worker .
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/domain packages/domain
COPY apps/worker apps/worker
RUN pnpm install --frozen-lockfile --filter @reelsflow/worker...
USER node
CMD ["pnpm", "--filter", "@reelsflow/worker", "start"]
