#!/usr/bin/env bash
# Ship the current working tree to the server and bring the stack up.
#
#   HOST=root@1.2.3.4 MCP_HOSTNAME=mcp.example.com ./deploy/deploy.sh
#
# Idempotent: re-run it to deploy a change. Caddy keeps its certificate in a
# named volume, so redeploys do not re-issue and cannot hit rate limits.
set -euo pipefail

: "${HOST:?set HOST=user@server}"
: "${MCP_HOSTNAME:?set MCP_HOSTNAME=mcp.example.com}"
REMOTE_DIR="${REMOTE_DIR:-/opt/willmehr}"

cd "$(dirname "$0")/.."

echo "==> Syncing to $HOST:$REMOTE_DIR"
# .env and *.har are excluded deliberately, not incidentally: the local .env
# holds a willhaben session cookie and the HAR holds the capture it came from.
# Neither has any business on a public server, and the server writes its own
# .env below.
rsync -az --delete \
  --exclude node_modules \
  --exclude dist \
  --exclude .git \
  --exclude .env \
  --exclude '*.har' \
  --exclude '.DS_Store' \
  ./ "$HOST:$REMOTE_DIR/"

echo "==> Building and starting"
ssh "$HOST" "cd '$REMOTE_DIR' \
  && printf 'MCP_HOSTNAME=%s\n' '$MCP_HOSTNAME' > .env \
  && docker compose up -d --build \
  && docker compose ps"

echo "==> Waiting for https://$MCP_HOSTNAME/healthz"
# First boot includes a Let's Encrypt challenge, so allow a couple of minutes.
for _ in $(seq 1 36); do
  if health=$(curl -fsS --max-time 5 "https://$MCP_HOSTNAME/healthz" 2>/dev/null); then
    echo "$health"
    echo
    echo "Live. Register it with:"
    echo "  claude mcp add --transport http willhaben https://$MCP_HOSTNAME/willhaben/mcp"
    echo "  claude mcp add --transport http kleinanzeigen https://$MCP_HOSTNAME/kleinanzeigen/mcp"
    exit 0
  fi
  sleep 5
done

echo "Health check never passed. Look at the logs:" >&2
echo "  ssh $HOST 'cd $REMOTE_DIR && docker compose logs --tail 50'" >&2
echo "Most common cause: $MCP_HOSTNAME does not resolve to this box yet, so Caddy" >&2
echo "cannot complete the ACME challenge." >&2
exit 1
