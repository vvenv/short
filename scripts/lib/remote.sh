#!/usr/bin/env bash
# 本地连生产服务器：读仓库根目录 .env.production（参考 scripts/env.production.example，不提交）。

load_production_env() {
  if [ -f "$ROOT/.env.production" ]; then
    set -a
    # shellcheck disable=SC1091
    source "$ROOT/.env.production"
    set +a
  fi
  : "${DEPLOY_HOST:?请在 .env.production 设置 DEPLOY_HOST（见 scripts/env.production.example）}"
  DEPLOY_SSH_USER="${DEPLOY_SSH_USER:-root}"
  DEPLOY_SSH_PORT="${DEPLOY_SSH_PORT:-22}"
  S_DOMAIN="${S_DOMAIN:-s.wenfu.dev}"
  MM_ORIGIN="${MM_ORIGIN:-https://mm.wenfu.dev}"
  S_OPT_ROOT="${S_OPT_ROOT:-/opt/short}"
  S_DATA_DIR="${S_DATA_DIR:-/var/lib/short}"
  S_PORT="${S_PORT:-8787}"
  REMOTE_TARGET="$DEPLOY_SSH_USER@$DEPLOY_HOST"
  if [ -n "${DEPLOY_SSH_PASSWORD:-}" ]; then
    command -v sshpass >/dev/null || {
      echo "设置了 DEPLOY_SSH_PASSWORD 需安装 sshpass（建议改用密钥）" >&2
      exit 1
    }
    export SSHPASS="$DEPLOY_SSH_PASSWORD"
  fi
}

with_auth() {
  if [ -n "${SSHPASS:-}" ]; then
    sshpass -e "$@"
  else
    "$@"
  fi
}

ssh_cmd() {
  if [ -n "${SSHPASS:-}" ]; then
    printf '%s\n' "sshpass -e ssh -p $DEPLOY_SSH_PORT -o StrictHostKeyChecking=accept-new"
  else
    printf '%s\n' "ssh -p $DEPLOY_SSH_PORT -o StrictHostKeyChecking=accept-new"
  fi
}

remote_ssh() {
  local tty_flag="-T"
  if [ "${1:-}" = "-t" ]; then
    [ -t 0 ] && tty_flag="-t"
    shift
  fi
  with_auth ssh "$tty_flag" -p "$DEPLOY_SSH_PORT" -o StrictHostKeyChecking=accept-new \
    "$REMOTE_TARGET" "$@"
}

remote_scp() {
  with_auth scp -P "$DEPLOY_SSH_PORT" -o StrictHostKeyChecking=accept-new \
    "$1" "$REMOTE_TARGET:$2"
}

remote_rsync() {
  rsync -rlptz --delete -e "$(ssh_cmd)" "$1" "$REMOTE_TARGET:$2"
}
