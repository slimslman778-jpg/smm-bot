FROM node:20-bookworm-slim

# الأدوات المطلوبة
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ffmpeg \
       python3 \
       python3-pip \
       curl \
       ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# تثبيت Deno
RUN curl -fsSL https://deno.land/install.sh | sh

ENV DENO_INSTALL=/root/.deno
ENV PATH=/root/.deno/bin:$PATH

# تحديث yt-dlp مع مكونات EJS
RUN python3 -m pip install \
    --break-system-packages \
    --no-cache-dir \
    -U "yt-dlp[default]" \
    yt-dlp-ejs

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production

EXPOSE 10000

CMD ["npm", "start"]
