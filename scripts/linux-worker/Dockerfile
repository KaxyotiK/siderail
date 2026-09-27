# Linux release worker: Debian 12, one Node major, and a pinned, checksummed
# Herdr binary. Built and run by scripts/run-linux-worker.sh.
ARG NODE_MAJOR=24
FROM node:${NODE_MAJOR}-bookworm
ARG HERDR_VERSION=0.9.1
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git procps \
 && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
  case "$TARGETARCH" in \
    arm64) asset=herdr-linux-aarch64; sum=f4ccf4de745f2cb9a39a983e9ba3703dad50ec2a58dea83026ceab721bbd8d9e ;; \
    amd64) asset=herdr-linux-x86_64; sum=2a02fed16beb651ef006e1d43f048f652ca4dc58ad053cd2d44450563d5c54b7 ;; \
    *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
  esac; \
  test "$HERDR_VERSION" = 0.9.1 || { echo "update the pinned checksums with HERDR_VERSION" >&2; exit 1; }; \
  curl -fsSL -o /usr/local/bin/herdr "https://github.com/herdrdev/herdr/releases/download/v${HERDR_VERSION}/${asset}"; \
  echo "$sum  /usr/local/bin/herdr" | sha256sum -c -; \
  chmod 755 /usr/local/bin/herdr
USER node
RUN git config --global --add safe.directory '*'
WORKDIR /home/node
