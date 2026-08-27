FROM node:22-bookworm

RUN apt-get update -qq && apt-get install -y --no-install-recommends python3 python3-venv curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/inference-venv
ENV PATH="/opt/inference-venv/bin:${PATH}" \
    NODE_ENV=production \
    ANIME_LAMA_MODEL_PATH=/app/models/anime-manga-big-lama.pt \
    COMIC_TEXT_DETECTOR_PATH=/app/models/comictextdetector.pt.onnx

WORKDIR /app
COPY requirements-inference.txt ./
RUN pip install --no-cache-dir -r requirements-inference.txt
RUN mkdir -p /app/models \
 && curl --fail --location --retry 3 --retry-delay 2 https://github.com/Sanster/models/releases/download/AnimeMangaInpainting/anime-manga-big-lama.pt -o /app/models/anime-manga-big-lama.pt \
 && echo "29f284f36a0a510bcacf39ecf4c4d54f  /app/models/anime-manga-big-lama.pt" | md5sum -c - \
 && curl --fail --location --retry 3 --retry-delay 2 https://github.com/zyddnys/manga-image-translator/releases/download/beta-0.2.1/comictextdetector.pt.onnx -o /app/models/comictextdetector.pt.onnx \
 && echo "1a86ace74961413cbd650002e7bb4dcec4980ffa21b2f19b86933372071d718f  /app/models/comictextdetector.pt.onnx" | sha256sum -c -

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod=false
COPY . .
RUN pnpm build && chmod +x scripts/start-standalone.sh

EXPOSE 3000
CMD ["pnpm", "start"]
