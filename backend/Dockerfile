FROM node:24-alpine AS frontend
WORKDIR /build
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY frontend/ ./
RUN pnpm build

FROM python:3.13-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN apt-get update \
    && apt-get install --no-install-recommends -y ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && addgroup --system --gid 10001 vita29 \
    && adduser --system --uid 10001 --ingroup vita29 vita29
WORKDIR /app
COPY backend/pyproject.toml ./
COPY backend/src ./src
COPY --from=frontend /build/dist ./src/vita29/static
RUN pip install --no-cache-dir .
COPY backend/alembic.ini ./
COPY backend/migrations ./migrations
RUN mkdir -p /data/app /data/media && chown -R vita29:vita29 /data /app
USER vita29
EXPOSE 8000
CMD ["sh", "-c", "alembic upgrade head && uvicorn vita29.main:app --host 0.0.0.0 --port 8000"]
