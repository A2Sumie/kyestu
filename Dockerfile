# kyestu all-in-one image: bun runtime + pinned Chrome + ffmpeg + biliup python.
# Chrome version matches idol-bbq's production pin; the browser-pool also
# auto-provisions this build on bare-metal hosts without a system Chrome.
ARG CHROME_VERSION=142.0.7444.175-1

FROM oven/bun:1.2.8-slim AS base

WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
COPY ./src ./src
COPY ./packages ./packages
COPY ./assets ./assets
COPY ./scripts ./scripts
RUN bun install --frozen-lockfile

FROM base AS runner

ARG CHROME_VERSION
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       wget curl ca-certificates unzip ffmpeg xvfb dbus-x11 python3 python3-venv \
       fonts-ipafont-gothic fonts-ipafont-mincho fonts-liberation fonts-noto-cjk \
       libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 \
       libcurl4 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 \
       libpango-1.0-0 libu2f-udev libvulkan1 libx11-xcb1 libxcomposite1 libxdamage1 \
       libxfixes3 libxkbcommon0 libxrandr2 libxshmfence1 libxss1 xdg-utils \
       mesa-vulkan-drivers libgl1-mesa-dri \
    && rm -rf /var/lib/apt/lists/*

RUN wget --no-verbose -O /tmp/chrome.deb https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${CHROME_VERSION}_amd64.deb \
    && apt install -y /tmp/chrome.deb \
    && rm /tmp/chrome.deb

# biliup helper venv at the paths the imported production config expects
# (video_upload.python_path / helper_path pass through the importer verbatim)
RUN python3 -m venv /app/tools/biliup-venv \
    && /app/tools/biliup-venv/bin/pip install --no-cache-dir biliup \
    && mkdir -p /app/tools/bin \
    && ln -s /app/tools/biliup-venv/bin/python /app/tools/bin/biliup-python \
    && cp /app/scripts/biliup-upload.py /app/tools/biliup-upload.py \
    && chmod +x /app/tools/biliup-upload.py

RUN chown -R bun:bun /app
USER bun

ENV NO_SANDBOX=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV FONTS_DIR=/app/assets/fonts
ENV ENABLE_XVFB=1
ENV XVFB_DISPLAY=:99
ENV XVFB_SCREEN="0 1600x1200x24"

CMD ["bun", "src/main.ts", "kyestu.config.yaml"]
