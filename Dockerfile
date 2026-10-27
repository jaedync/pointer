FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js room.js persist.js ./
COPY public/ ./public/
# Room snapshot (written on SIGTERM, read at boot). An anonymous volume:
# `docker compose up` hands it to the recreated container, so rooms survive
# a rebuild without a compose change.
ENV POINTER_STATE_FILE=/app/data/rooms.json
VOLUME /app/data
EXPOSE 3000
CMD ["node", "server.js"]
