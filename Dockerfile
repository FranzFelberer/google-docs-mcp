FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist/ dist/

# Build arg for traceability
ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=${GIT_COMMIT}

ENV MCP_TRANSPORT=http
ENV NODE_ENV=production

USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
