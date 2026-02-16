FROM mcr.microsoft.com/playwright:v1.58.2-noble

WORKDIR /workspace

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    tini \
    && rm -rf /var/lib/apt/lists/*

# Install Codex CLI globally.
RUN npm install -g @openai/codex@latest

# Create a non-root user for shell sessions and task runs.
RUN useradd -m -u 10001 -s /bin/bash codex
USER codex

COPY --chown=codex:codex docker/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY --chown=codex:codex . /workspace
RUN chmod 0755 /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["shell"]
