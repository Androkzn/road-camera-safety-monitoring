# syntax=docker/dockerfile:1.7

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — build the React frontend.
# Runs in a Node image so we don't have to install npm into the Python image.
# Only the produced `dist/` bundle is copied into the runtime stage below.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-slim AS frontend-build

WORKDIR /build

# Copy lockfiles first so the layer is cached when only source code changes.
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

# Now copy the rest of the frontend and run the production build (tsc + vite).
COPY frontend/ ./
RUN npm run build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — Python runtime. Installs system libs for OpenCV (libgl1,
# libglib2.0-0) and the ffmpeg binary that yt-dlp / OpenCV call out to.
# ─────────────────────────────────────────────────────────────────────────────
FROM python:3.12-slim AS runtime

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libgl1 libglib2.0-0 ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first so the layer is cached when only source changes.
COPY pyproject.toml ./
RUN pip install --no-cache-dir .

# Python sources.
COPY road_safety/ road_safety/
COPY cloud/ cloud/
COPY data/corpus/ data/corpus/
COPY start.py ./

# Pull the compiled React bundle from the frontend-build stage into the
# location road_safety/config.py expects (PROJECT_ROOT / "frontend" / "dist").
COPY --from=frontend-build /build/dist/ frontend/dist/

# Runtime directories the app writes into.
RUN mkdir -p data/thumbnails data/active_learning/pending

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/admin/health')" || exit 1

CMD ["python", "-m", "uvicorn", "road_safety.server:app", \
     "--host", "0.0.0.0", "--port", "8000", "--log-level", "info"]
