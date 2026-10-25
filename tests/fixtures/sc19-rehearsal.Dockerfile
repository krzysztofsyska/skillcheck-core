ARG PG_MAJOR
ARG PG_IMAGE_TAG=${PG_MAJOR}
FROM postgres:${PG_IMAGE_TAG}-bookworm
ARG PG_MAJOR
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-${PG_MAJOR}-cron && rm -rf /var/lib/apt/lists/*
