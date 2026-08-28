FROM node:20-bookworm

WORKDIR /app

RUN apt-get update \
    && apt-get install -y \
        ffmpeg \
        python3 \
        python3-pip \
        ca-certificates \
        curl \
    && pip3 install --break-system-packages --no-cache-dir -U yt-dlp \
    && yt-dlp --version \
    && ffmpeg -version \
    && ffprobe -version \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production

EXPOSE 10000

CMD ["npm", "start"]
