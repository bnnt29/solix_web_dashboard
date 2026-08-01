FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app/solix_web_dashboard/src:/app/solix_web_dashboard/src/api

WORKDIR /app

RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends gcc build-essential git \
    && rm -rf /var/lib/apt/lists/*

EXPOSE 8080

RUN useradd --create-home --uid 10001 appuser \
    && chown appuser:appuser /app

# Clone dashboard
RUN git clone --recurse-submodules https://github.com/bnnt29/solix_web_dashboard.git /app/solix_web_dashboard

RUN pip install --no-cache-dir -r /app/solix_web_dashboard/Docker/requirements.txt \
    && chown -R appuser:appuser /app/solix_web_dashboard

USER appuser
WORKDIR /app/solix_web_dashboard

CMD ["python", "/app/solix_web_dashboard/src/api/pv_monitor.py", \
     "--live-cloud", \
     "--energy-stats", \
     "--interval", "6", \
     "--sample-interval", "3", \
     "--storage-root", "/app/solix_web_dashboard/src/dashboard/exports/timeseries", \
     "--web-folder", "/app/solix_web_dashboard/src/dashboard", \
     "--web-host", "0.0.0.0", \
     "--web-port", "8080", \
    "--config", "/app/solix_web_dashboard/config/solix-monitor.config.json", \
     "--console-detail", "compact", \
     "--console-log-level", "INFO", "--dashboard-light"]