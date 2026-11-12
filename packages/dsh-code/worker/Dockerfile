# Code workspace worker image: the tools an agent needs inside the gVisor
# sandbox. Harness itself never runs here. Pin both bases by digest in releases.
FROM node:24-bookworm-slim AS node
FROM ubuntu:24.04
# Build-time CA for TLS-intercepting proxies only; never left in the image.
# ubuntu:24.04 ships no CA bundle, so ca-certificates comes over the signed http sources first.
COPY Dockerfile build-ca.crt* /tmp/build/
RUN CA=; if [ -s /tmp/build/build-ca.crt ]; then CA='-o Acquire::https::CaInfo=/tmp/build/build-ca.crt'; fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && sed -i 's|http://|https://|g' /etc/apt/sources.list.d/ubuntu.sources \
 && apt-get $CA update \
 && apt-get $CA install -y --no-install-recommends \
      git bash ripgrep python3 build-essential procps less curl \
 && rm -rf /var/lib/apt/lists/* /tmp/build \
 && git config --system safe.directory '*' \
 && git config --system init.defaultBranch main
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
