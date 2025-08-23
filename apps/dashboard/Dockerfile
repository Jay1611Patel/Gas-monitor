FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY index.html ./
COPY vite.config.js ./
COPY postcss.config.js ./
COPY tailwind.config.js ./
COPY src ./src
COPY public ./public
EXPOSE 5173
ENV VITE_API_BASE=http://localhost:4000
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]