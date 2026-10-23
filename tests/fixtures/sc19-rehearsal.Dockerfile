ARG PG_MAJOR
FROM postgres:${PG_MAJOR}-bookworm
ARG PG_MAJOR
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-${PG_MAJOR}-cron && rm -rf /var/lib/apt/lists/*
