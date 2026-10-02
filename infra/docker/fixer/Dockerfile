# syntax=docker/dockerfile:1
#
# The Snapwing fixer image (main 10.2, main 14.3, main 14.5, ADR 0003, ADR 0017 with amendment 1).
# The docker runner (packages/app/src/providers/docker/runner.ts) starts it for fixer runs
# (`snapwing-fixer-<runId>`), review runs (`snapwing-review-<runId>`), both through the entrypoint
# wrapper, and regression-proof test runs (`snapwing-tests-<runId>`, `--entrypoint sh`).
#
# Build from the repository root (docs/harness-generic.md section 8):
#   pnpm fixer-image:build
#   pnpm fixer-image:build --build-arg INSTALL_CODEX=true --build-arg INSTALL_GEMINI=true
# and point the server at it with SNAPWING_FIXER_IMAGE=snapwing-fixer:local.
#
# No secret is baked in, and none may be: no provider key, no token, no .env. Model calls go to the
# server's model proxy with a per-run token the runner passes at `docker run` time, and the fixer API
# token and git credential arrive the same way. Only `packages/pipeline/src` (the harness adapters
# and prompts) and this directory are copied in (Dockerfile.dockerignore).

ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-bookworm-slim

# Agent CLIs. claude-code is the default harness. The codex and gemini package names and the flags
# their adapters use are from memory (#150, #232); check them against the CLIs' own help when enabling.
ARG CLAUDE_CODE_VERSION=latest
ARG INSTALL_CODEX=false
ARG CODEX_VERSION=latest
ARG INSTALL_GEMINI=false
ARG GEMINI_VERSION=latest

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git tini \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && if [ "${INSTALL_CODEX}" = "true" ]; then npm install -g "@openai/codex@${CODEX_VERSION}"; fi \
 && if [ "${INSTALL_GEMINI}" = "true" ]; then npm install -g "@google/gemini-cli@${GEMINI_VERSION}"; fi \
 && npm cache clean --force

# The wrapper runs the same harness adapters as the local runner, from source (Node strips the types).
WORKDIR /opt/snapwing
RUN printf '{ "private": true, "type": "module" }\n' > package.json \
 && mkdir -p /etc/snapwing/generic
COPY packages/pipeline/src packages/pipeline/src
COPY infra/docker/fixer/wrapper.ts infra/docker/fixer/entrypoint.ts infra/docker/fixer/askpass infra/docker/fixer/
RUN chmod 0755 infra/docker/fixer/askpass

# A non-root user for fixer runs; test and review runs get the server's uid:gid from the runner.
RUN useradd --uid 10001 --user-group --create-home --shell /usr/sbin/nologin snapwing
USER snapwing
ENV SNAPWING_GENERIC_DIR=/etc/snapwing/generic
WORKDIR /work

ENTRYPOINT ["/usr/bin/tini", "--", "node", "--disable-warning=ExperimentalWarning", "/opt/snapwing/infra/docker/fixer/entrypoint.ts"]
