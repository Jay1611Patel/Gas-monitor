FROM node:20-bullseye
RUN apt-get update && apt-get install -y git python3 build-essential && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY src ./src
ENV GITHUB_TOKEN=
CMD ["npm", "start"]