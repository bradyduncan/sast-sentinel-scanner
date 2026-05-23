# Fargate scanner container. Wraps sast/backend/cli.js.
#
# Build (from repo root):
#   docker build -f docker/Dockerfile -t sast-scanner:dev sast/backend
#
# Run locally with env vars from docs/contracts.md (requires AWS credentials):
#   docker run --rm \
#     -e JOB_ID=test -e STAGING_BUCKET=... -e STAGING_KEY=... \
#     -e RESULTS_BUCKET=... -e RESULTS_KEY=... -e JOBS_TABLE=... \
#     -e AWS_REGION=us-east-1 \
#     -v $HOME/.aws:/home/node/.aws:ro \
#     sast-scanner:dev

# ---- Stage 1: install production deps in a clean layer ----
FROM node:20-alpine AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- Stage 2: minimal runtime image ----
FROM node:20-alpine AS runtime

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY scanner.js cli.js ./

USER node
ENV NODE_ENV=production

CMD ["node", "cli.js"]
