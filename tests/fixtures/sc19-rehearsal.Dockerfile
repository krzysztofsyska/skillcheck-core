ARG PG_MAJOR
ARG PG_IMAGE_TAG=${PG_MAJOR}
FROM postgres:${PG_IMAGE_TAG}-bookworm
ARG PG_MAJOR
# The server package is held so installing pg_cron can never move the server off the image's
# pinned minor version. A pg_cron build that demands a newer server is skipped in favour of the
# newest one that installs against the held server; the build fails if none does.
RUN set -eu; apt-get update; apt-mark hold "postgresql-${PG_MAJOR}"; installed=''; \
    for version in $(apt-cache madison "postgresql-${PG_MAJOR}-cron" | awk '{print $3}'); do \
      if apt-get install -y --no-install-recommends "postgresql-${PG_MAJOR}-cron=${version}"; then installed="${version}"; break; fi; \
    done; \
    test -n "${installed}"; echo "pg_cron package: ${installed}"; \
    rm -rf /var/lib/apt/lists/*
