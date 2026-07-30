FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app/solix_web_dashboard/src:/app/solix_web_dashboard/src/api

WORKDIR /app

# Optional but useful for some Python packages that need compilation.
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc build-essential git \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

RUN git clone --recurse-submodules https://github.com/bnnt29/solix_web_dashboard.git solix_web_dashboard


RUN pip install --no-cache-dir -r requirements.txt

WORKDIR /app/solix_web_dashboard


COPY . .

# Webserver port
EXPOSE 8080

CMD ["python", "src/api/pv_monitor.py", \
     "--live-cloud", \
     "--energy-stats", \
     "--interval", "30", \
     "--sample-interval", "10", \
     "--storage-root", "src/dashboard/exports/timeseries", \
     "--web-folder", "src/dashboard", \
     "--web-host", "0.0.0.0", \
     "--web-port", "8080", \
     "--config", "/app/solix_web_dashboard/config/solix-monitor.config.json", \
     "--console-detail", "compact", \
     "--console-log-level", "INFO"]