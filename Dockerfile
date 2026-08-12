FROM node:22-alpine

WORKDIR /app

# No dependencies to install — the server uses only Node built-ins, so the
# image is just the runtime plus two source files.
COPY package.json ./
COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
