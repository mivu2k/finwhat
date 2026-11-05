#!/usr/bin/env bash
# Run on the server as root: pulls the latest code, rebuilds the web app, restarts the API.
set -euo pipefail
cd /opt/expensechat
sudo -u expensechat git pull --ff-only
sudo -u expensechat npm ci
sudo -u expensechat bash -c 'set -a; . ./.env; set +a; npx expo export --platform web --output-dir dist'
systemctl restart expensechat-api
sleep 2
systemctl is-active expensechat-api
