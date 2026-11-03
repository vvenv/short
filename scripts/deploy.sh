#!/usr/bin/env bash
# 发布短链服务到 s.wenfu.dev：同步代码、装 systemd、装 nginx、没有证书就申请。
#
#   bash scripts/deploy.sh
#   pnpm deploy
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# shellcheck source=scripts/lib/remote.sh
source "$ROOT/scripts/lib/remote.sh"

load_production_env

DOMAIN="$S_DOMAIN"
OPT_ROOT="$S_OPT_ROOT"
DATA_DIR="$S_DATA_DIR"
SITE_AVAILABLE="/etc/nginx/sites-available/${DOMAIN}"
SITE_ENABLED="/etc/nginx/sites-enabled/${DOMAIN}"
UNIT_SRC="$ROOT/deploy/systemd/short.service"
UNIT_DST="/etc/systemd/system/short.service"

log() { printf '[short] %s\n' "$*"; }
die() { printf '[short] %s\n' "$*" >&2; exit 1; }

install_nginx() {
  local conf="$1"
  log "安装 nginx 站点 ${DOMAIN}"
  remote_scp "$conf" "/tmp/${DOMAIN}.conf"
  remote_ssh "cp /tmp/${DOMAIN}.conf ${SITE_AVAILABLE} && ln -sfn ${SITE_AVAILABLE} ${SITE_ENABLED} && nginx -t && systemctl reload nginx"
}

[ -f "$ROOT/server.mjs" ] || die "缺少 $ROOT/server.mjs"
[ -f "$UNIT_SRC" ] || die "缺少 $UNIT_SRC"
command -v rsync >/dev/null || die "需要本机安装 rsync"
command -v node >/dev/null || true

log "同步到 ${REMOTE_TARGET}:${OPT_ROOT}"
remote_ssh "mkdir -p $(printf '%q' "$OPT_ROOT") $(printf '%q' "$DATA_DIR") /var/www/certbot"
with_auth rsync -rlptz --delete \
  --exclude '.git/' \
  --exclude 'data/' \
  --exclude '.env' \
  --exclude '.env.production' \
  --exclude 'node_modules/' \
  --exclude '.DS_Store' \
  -e "$(ssh_cmd)" \
  "${ROOT}/" "${REMOTE_TARGET}:${OPT_ROOT}/"

remote_scp "$UNIT_SRC" /tmp/short.service
remote_ssh "chown -R www-data:www-data $(printf '%q' "$DATA_DIR") && chmod 0750 $(printf '%q' "$DATA_DIR")"
remote_ssh "chown -R root:root $(printf '%q' "$OPT_ROOT") && chmod 0755 $(printf '%q' "$OPT_ROOT") && chmod 0644 $(printf '%q' "$OPT_ROOT")/server.mjs $(printf '%q' "$OPT_ROOT")/package.json"

log "安装 systemd unit 并重启"
remote_ssh "cp /tmp/short.service ${UNIT_DST} && systemctl daemon-reload && systemctl enable short.service && systemctl restart short.service"
remote_ssh "systemctl is-active short.service" >/dev/null || die "short.service 未处于 active"

if ! remote_ssh "test -f /etc/letsencrypt/live/${DOMAIN}/fullchain.pem"; then
  install_nginx "$ROOT/deploy/nginx/${DOMAIN}.http-only.conf"
  log "申请证书 ${DOMAIN}"
  remote_ssh "certbot certonly --webroot -w /var/www/certbot -d ${DOMAIN} --non-interactive --agree-tos --keep-until-expiring"
fi

install_nginx "$ROOT/deploy/nginx/${DOMAIN}.conf"

log "健康检查 https://${DOMAIN}/health"
UA='Mozilla/5.0 (compatible; short-deploy/1.0)'
ok=0
for _ in 1 2 3 4 5 6 7 8; do
  code="$(curl -sS -o /tmp/short-deploy-check.json -w '%{http_code}' -A "$UA" "https://${DOMAIN}/health" || true)"
  if [ "$code" = "200" ] && grep -aq '"ok"' /tmp/short-deploy-check.json; then
    ok=1
    break
  fi
  sleep 1
done
[ "$ok" = 1 ] || die "HTTPS 健康检查失败（确认 DNS ${DOMAIN} 已指向 ${DEPLOY_HOST}）"

log "已发布 https://${DOMAIN}/"
