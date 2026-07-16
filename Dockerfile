# SezonlukDizi Stremio addon.
# node:22-slim carries full ICU (needed for windows-1254 decoding); deps are
# installed at build time so the container starts with just `node`.
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
CMD ["node", "addon.js"]
