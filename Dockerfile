FROM node:22-alpine

WORKDIR /app

# No dependencies to install — the server uses only Node built-ins, so there
# is no npm install step and the image is the runtime plus the source.
#
# Copy the whole source tree rather than naming files. Enumerating them meant
# a newly added module silently missed the image and only failed at runtime —
# which is how both auth.js and host.js broke a deploy. .dockerignore keeps
# .env, .git and node_modules out.
COPY . .
RUN rm -rf .env .env.* 2>/dev/null || true

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
