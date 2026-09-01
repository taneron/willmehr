#!/usr/bin/env bash
# Run once, as root, on a fresh Debian or Ubuntu VPS:
#
#   ssh root@<ip> 'bash -s' < deploy/bootstrap-server.sh
#
# Installs Docker, opens the two ports Caddy needs, and turns on unattended
# security updates. Nothing here is willmehr-specific — deploy/deploy.sh does
# the actual install.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl rsync ufw unattended-upgrades

if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi

# SSH first: enabling the firewall before allowing it locks you out.
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

systemctl enable --now docker

echo
echo "Ready. Docker $(docker --version | awk '{print $3}' | tr -d ,), ports 80/443 open."
echo "Next, from your laptop:"
echo "  HOST=root@<ip> MCP_HOSTNAME=<your.subdomain> ./deploy/deploy.sh"
