FROM node:22-alpine AS build

RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json yarn.lock ./
COPY artifacts/local-delivery/dtx-tool-auth-1.0.0.tgz /tmp/dtx-tool-auth-1.0.0.tgz
RUN node -e "const fs=require('fs'); const p=require('./package.json'); p.dependencies['@dtx/tool-auth']='file:/tmp/dtx-tool-auth-1.0.0.tgz'; fs.writeFileSync('package.json', JSON.stringify(p));" \
 && yarn install --no-lockfile \
 && node -e "const fs=require('fs'); const p=require('./package.json'); p.dependencies['@dtx/tool-auth']='1.0.0'; fs.writeFileSync('package.json', JSON.stringify(p));"
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY web ./web
COPY scripts ./scripts
COPY tests/fixtures ./tests/fixtures
RUN yarn typecheck

FROM node:22-alpine AS runtime

RUN apk add --no-cache dumb-init libstdc++ su-exec
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/yarn.lock ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/web ./web
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod 755 /app/docker-entrypoint.sh && chown -R node:node /app
ENTRYPOINT ["/usr/bin/dumb-init", "--", "/app/docker-entrypoint.sh"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 CMD node -e "fetch('http://127.0.0.1:8787/ccp/v1/health').then(async(r)=>{const b=await r.json().catch(()=>null);process.exit(r.ok&&b?.ok===true&&b?.signer==='configured'?0:1)}).catch(()=>process.exit(1))"
