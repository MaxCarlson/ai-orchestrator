FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    jq \
    curl \
    bash \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first (for layer caching)
COPY docker/orchestrator/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy shared modules (task queue)
COPY shared/ /app/shared/

# Copy orchestrator code
COPY docker/orchestrator/*.py /app/

# Create directories
RUN mkdir -p /app/logs

# Expose API port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# Run orchestrator
CMD ["python", "main.py"]
