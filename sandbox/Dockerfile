ARG SANDBOX_BASE=boltdiy-claude-sandbox:mvp
FROM ${SANDBOX_BASE}

COPY sandbox/bin/newbolt-agent /usr/local/bin/newbolt-agent
COPY sandbox/bin/newbolt-preview /usr/local/bin/newbolt-preview
COPY sandbox/bin/newbolt-claude-presenter /usr/local/bin/newbolt-claude-presenter
COPY sandbox/bin/newbolt-sandbox-server /usr/local/bin/newbolt-sandbox-server

WORKDIR /workspace

ENV SANDBOX_SERVER_PORT=7070

CMD ["node", "/usr/local/bin/newbolt-sandbox-server"]
