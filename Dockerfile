FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# Optional but useful for some Python packages that need compilation.
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc build-essential git \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Webserver port
EXPOSE 8080

CMD ["python", "src/api/pv_monitor.py"]