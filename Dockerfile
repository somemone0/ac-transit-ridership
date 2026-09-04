# syntax=docker/dockerfile:1

# The data bundle is not baked in -- the browser fetches it straight from the
# public GCS bucket named by NEXT_PUBLIC_PACK_BASE, so this image carries only
# the app. That keeps it small enough for a cold start to stay snappy.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Baked into the client bundle at build time, so it has to be present here and
# not just at run time.
ARG NEXT_PUBLIC_PACK_BASE
ARG NEXT_PUBLIC_CARTO_KEY
ENV NEXT_PUBLIC_PACK_BASE=$NEXT_PUBLIC_PACK_BASE
ENV NEXT_PUBLIC_CARTO_KEY=$NEXT_PUBLIC_CARTO_KEY
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
# Cloud Run sets PORT; the standalone server reads it.
ENV PORT=8080
ENV HOSTNAME=0.0.0.0
EXPOSE 8080
CMD ["node", "server.js"]
