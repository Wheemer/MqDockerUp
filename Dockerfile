FROM node:lts-alpine AS build

RUN apk add --no-cache g++ make py3-pip

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:lts-alpine

RUN apk add --no-cache tini

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/assets ./assets

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
