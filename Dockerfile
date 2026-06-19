# Build stage — compile TypeScript
FROM node:20-alpine AS build
WORKDIR /app

# Install deps from lockfile for reproducibility
COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune dev dependencies before copying into runtime
RUN npm prune --omit=dev

# Runtime stage — slim image, non-root user
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Non-root: matches Cloud Run best practice
RUN addgroup -S app && adduser -S app -G app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

USER app
EXPOSE 8080
CMD ["node", "dist/server.js"]
