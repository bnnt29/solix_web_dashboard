FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app/solix_web_dashboard/src:/app/solix_web_dashboard/src/api

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc build-essential git \
    && rm -rf /var/lib/apt/lists/*

# Clone dashboard
RUN git clone --recurse-submodules https://github.com/bnnt29/solix_web_dashboard.git /app/solix_web_dashboard

# Clone missing solix_api dependency into the exact path expected by pv_monitor.py
RUN rm -rf /app/solix_web_dashboard/src/solix_api \
    && git clone https://github.com/thomluther/anker-solix-api.git /app/solix_web_dashboard/src/solix_api

RUN pip install --no-cache-dir -r requirements.txt


WORKDIR /app/solix_web_dashboard


EXPOSE 8080

CMD ["python", "/app/solix_web_dashboard/src/api/pv_monitor.py", \
     "--live-cloud", \
     "--energy-stats", \
     "--interval", "30", \
     "--sample-interval", "10", \
     "--storage-root", "/app/solix_web_dashboard/src/dashboard/exports/timeseries", \
     "--web-folder", "/app/solix_web_dashboard/src/dashboard", \
     "--web-host", "0.0.0.0", \
     "--web-port", "8080", \
     "--config", "/app/config/solix-monitor.config.json", \
     "--console-detail", "compact", \
     "--console-log-level", "INFO"]