# kyestu all-in-one image: bun runtime + pinned Chrome + ffmpeg + biliup python.
#
# Version pins and why (both are load-bearing, see notes):
# - bun 1.3.14: bun.lock is the text lockfile written by bun 1.3.x (README
#   requires >= 1.3); 1.2.x images fail `bun install --frozen-lockfile`.
# - Chrome 142.0.7444.175-1 on Debian bookworm: the spider hardcodes this
#   build in its UA/sec-ch-ua fingerprint (packages/spider/src/utils/browser.ts,
#   browser-pool.ts CHROME_FALLBACK_BUILD_ID), so the browser binary must stay
#   142. The 142 .deb depends on libasound2, which trixie renamed to
#   libasound2t64 — an unversioned Provides cannot satisfy the versioned dep,
#   so the runner must stay on bookworm even though official bun 1.3.x images
#   are trixie-based. Hence: install deps in the bun image, run on bookworm
#   with the bun binary copied over (verified: 1.3.14 runs on glibc 2.36).
# - linux/amd64 only: the pinned Chrome .deb is amd64; on arm64 hosts build
#   with `docker build --platform linux/amd64 ...`.
ARG CHROME_VERSION=142.0.7444.175-1
ARG BUN_IMAGE=oven/bun:1.3.14-slim

FROM ${BUN_IMAGE} AS base

WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
COPY ./src ./src
COPY ./packages ./packages
COPY ./assets ./assets
COPY ./scripts ./scripts
RUN bun install --frozen-lockfile

FROM ${BUN_IMAGE} AS bun-src
FROM debian:bookworm-slim AS runner

COPY --from=bun-src /usr/local/bin/bun /usr/local/bin/bun
COPY --from=bun-src /usr/local/bin/bunx /usr/local/bin/bunx

ARG CHROME_VERSION
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       wget curl ca-certificates unzip ffmpeg xvfb dbus-x11 python3 python3-venv zstd \
       fonts-ipafont-gothic fonts-ipafont-mincho fonts-liberation fonts-noto-cjk \
       libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 \
       libcurl4 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 \
       libpango-1.0-0 libu2f-udev libvulkan1 libx11-xcb1 libxcomposite1 libxdamage1 \
       libxfixes3 libxkbcommon0 libxrandr2 libxshmfence1 libxss1 xdg-utils \
       mesa-vulkan-drivers libgl1-mesa-dri \
    && rm -rf /var/lib/apt/lists/*

# apt lists were cleaned above; refresh them or the local .deb's dependencies
# resolve to "not installable".
RUN apt-get update \
    && wget --no-verbose -O /tmp/chrome.deb https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${CHROME_VERSION}_amd64.deb \
    && apt install -y /tmp/chrome.deb \
    && rm /tmp/chrome.deb \
    && rm -rf /var/lib/apt/lists/*

# `bun` user mirrors the official image (uid/gid 1000) so volume ownership
# stays predictable; must exist before any COPY --chown
RUN groupadd -g 1000 bun && useradd -u 1000 -g bun -d /app -s /bin/sh bun

# node_modules + sources from the install stage
COPY --from=base --chown=bun:bun /app /app

# biliup helper venv at the paths the imported production config expects
# (video_upload.python_path / helper_path pass through the importer verbatim)
RUN python3 -m venv /app/tools/biliup-venv \
    && /app/tools/biliup-venv/bin/pip install --no-cache-dir biliup \
    && mkdir -p /app/tools/bin \
    && ln -s /app/tools/biliup-venv/bin/python /app/tools/bin/biliup-python \
    && cp /app/scripts/biliup-upload.py /app/tools/biliup-upload.py \
    && chmod +x /app/tools/biliup-upload.py

RUN mkdir -p /app/data && chown -R bun:bun /app

WORKDIR /app
USER bun

ENV NO_SANDBOX=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV FONTS_DIR=/app/assets/fonts
ENV ENABLE_XVFB=1
ENV XVFB_DISPLAY=:99
ENV XVFB_SCREEN="0 1600x1200x24"

EXPOSE 3000

# Liveness: /api/status. Auth is skipped server-side when no secret is
# configured; when one is, it must come via the KYESTU_API_SECRET env (use
# `secret: env:KYESTU_API_SECRET` in the config) so this check can present
# the same Bearer token. A 200 only proves the control plane serves — failed
# fibers still return 200; alert on the payload's state/taints externally.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS -o /dev/null -H "Authorization: Bearer ${KYESTU_API_SECRET:-}" \
      "http://127.0.0.1:${KYESTU_API_PORT:-3000}/api/status" || exit 1

CMD ["bun", "src/main.ts", "kyestu.config.yaml"]
