#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRANCH="${BRANCH:-main}"
SERVICE_NAME="${SERVICE_NAME:-invoice-manager}"
NODE_ENV="${NODE_ENV:-production}"
PORT="${PORT:-3001}"
DEPLOY_USER="${DEPLOY_USER:-$(whoami)}"
DEPLOY_GROUP="${DEPLOY_GROUP:-$(id -gn)}"
SKIP_GIT_PULL="${SKIP_GIT_PULL:-0}"

if [[ "${EUID}" -eq 0 ]]; then
  SUDO=""
else
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    echo "[ERROR] sudo 不可用，请使用 root 运行或先安装 sudo。"
    exit 1
  fi
fi

log() {
  echo "[DEPLOY] $*"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[ERROR] 缺少命令: $1"
    exit 1
  fi
}

require_cmd git
require_cmd node
require_cmd npm
require_cmd systemctl

if [[ ! -d "${APP_DIR}/.git" ]]; then
  echo "[ERROR] ${APP_DIR} 不是 git 仓库目录。"
  exit 1
fi

if [[ ! -f "${APP_DIR}/server/.env" ]]; then
  echo "[ERROR] 未找到 ${APP_DIR}/server/.env，请先配置后再部署。"
  exit 1
fi

if [[ "${SKIP_GIT_PULL}" != "1" ]]; then
  log "更新代码分支: ${BRANCH}"
  git -C "${APP_DIR}" fetch --all --prune
  current_branch="$(git -C "${APP_DIR}" rev-parse --abbrev-ref HEAD)"
  if [[ "${current_branch}" != "${BRANCH}" ]]; then
    git -C "${APP_DIR}" checkout "${BRANCH}"
  fi
  git -C "${APP_DIR}" pull --ff-only origin "${BRANCH}"
else
  log "跳过 git 拉取（SKIP_GIT_PULL=1）"
fi

log "安装后端依赖"
npm --prefix "${APP_DIR}/server" ci --omit=dev

log "安装前端依赖"
npm --prefix "${APP_DIR}/web" ci

log "构建前端"
npm --prefix "${APP_DIR}/web" run build

log "准备 systemd 服务"
service_file="/etc/systemd/system/${SERVICE_NAME}.service"
tmp_service_file="$(mktemp)"

cat > "${tmp_service_file}" <<EOF
[Unit]
Description=Invoice Manager Service
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}/server
Environment=NODE_ENV=${NODE_ENV}
Environment=PORT=${PORT}
EnvironmentFile=-${APP_DIR}/server/.env
ExecStart=/usr/bin/env node index.js
Restart=always
RestartSec=3
User=${DEPLOY_USER}
Group=${DEPLOY_GROUP}
StandardOutput=append:${APP_DIR}/data/server.out.log
StandardError=append:${APP_DIR}/data/server.err.log

[Install]
WantedBy=multi-user.target
EOF

${SUDO} mkdir -p "${APP_DIR}/data"
${SUDO} cp "${tmp_service_file}" "${service_file}"
rm -f "${tmp_service_file}"

log "重载并重启服务: ${SERVICE_NAME}"
${SUDO} systemctl daemon-reload
${SUDO} systemctl enable "${SERVICE_NAME}"
${SUDO} systemctl restart "${SERVICE_NAME}"

log "服务状态"
${SUDO} systemctl --no-pager --full status "${SERVICE_NAME}" | sed -n '1,30p'

log "部署完成"
