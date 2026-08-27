FROM node:22-bookworm

RUN apt-get update -qq && apt-get install -y --no-install-recommends python3 python3-venv curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/inference-venv
ENV PATH="/opt/inference-venv/bin:${PATH}" \
    NODE_ENV=production \
    ANIME_LAMA_MODEL_PATH=/app/models/anime-manga-big-lama.pt

WORKDIR /app
COPY requirements-inference.txt ./
RUN pip install --no-cache-dir -r requirements-inference.txt
RUN mkdir -p /app/models && curl --fail --location --retry 3 --retry-delay 2 https://github.com/Sanster/models/releases/download/AnimeMangaInpainting/anime-manga-big-lama.pt -o /app/models/anime-manga-big-lama.pt && echo "29f284f36a0a510bcacf39ecf4c4d54f  /app/models/anime-manga-big-lama.pt" | md5sum -c -

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod=false
COPY . .
RUN pnpm build && chmod +x scripts/start-standalone.sh

EXPOSE 3000
CMD ["pnpm", "start"]
