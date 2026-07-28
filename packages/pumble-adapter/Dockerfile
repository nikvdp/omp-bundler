FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PUMBLE_BRIDGE_DATA_DIR=/data
ENV PUMBLE_BRIDGE_HOST=0.0.0.0
ENV PUMBLE_BRIDGE_PORT=8765

EXPOSE 8765

CMD ["npm", "run", "start"]
