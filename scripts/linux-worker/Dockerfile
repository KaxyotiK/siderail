# Linux release worker: Debian 12, one Node major, and a pinned, checksummed
# Herdr binary. Built and run by scripts/run-linux-worker.sh.
ARG NODE_MAJOR=24
FROM node:${NODE_MAJOR}-bookworm
ARG HERDR_VERSION=0.8.2
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git procps \
 && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
  case "$TARGETARCH" in \
    arm64) asset=herdr-linux-aarch64; sum=f55610658e1c2e0d2aaef730b4b2ab885f7f8ba00285ab372bfb14f2e3d5b40d ;; \
    amd64) asset=herdr-linux-x86_64; sum=976150a14d490c94b243ea2e1a7eb2dfb67f12e36b182db90936f6728e6aecf4 ;; \
    *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
  esac; \
  test "$HERDR_VERSION" = 0.8.2 || { echo "update the pinned checksums with HERDR_VERSION" >&2; exit 1; }; \
  curl -fsSL -o /usr/local/bin/herdr "https://github.com/herdrdev/herdr/releases/download/v${HERDR_VERSION}/${asset}"; \
  echo "$sum  /usr/local/bin/herdr" | sha256sum -c -; \
  chmod 755 /usr/local/bin/herdr
USER node
RUN git config --global --add safe.directory '*'
WORKDIR /home/node
