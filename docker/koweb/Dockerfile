FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY orchestrator_web_viewer/ /app/orchestrator_web_viewer/

RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -e /app/orchestrator_web_viewer

EXPOSE 3001

CMD ["koweb"]
