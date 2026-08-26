#!/bin/sh
set -eu

ACTION="${1:-status}"
HOME_DIR="${FIRECRAWL_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/lumen/firecrawl}"
VERSION="${FIRECRAWL_VERSION:-v2.11.0}"
REPOSITORY="https://github.com/firecrawl/firecrawl.git"
COMPOSE="${HOME_DIR}/docker-compose.yaml"

install_stack() {
  command -v git >/dev/null 2>&1 || { echo "git is required." >&2; exit 1; }
  command -v docker >/dev/null 2>&1 || { echo "Docker is required." >&2; exit 1; }
  if [ ! -f "$COMPOSE" ]; then
    mkdir -p "$(dirname "$HOME_DIR")"
    git clone --depth 1 --branch "$VERSION" "$REPOSITORY" "$HOME_DIR"
  fi
}

case "$ACTION" in
  install)
    install_stack
    ;;
  start)
    install_stack
    docker compose -f "$COMPOSE" up -d
    ;;
  stop)
    [ -f "$COMPOSE" ] && docker compose -f "$COMPOSE" down || true
    ;;
  restart)
    [ -f "$COMPOSE" ] && docker compose -f "$COMPOSE" down || true
    install_stack
    docker compose -f "$COMPOSE" up -d
    ;;
  status)
    [ -f "$COMPOSE" ] && docker compose -f "$COMPOSE" ps || echo "Firecrawl is not installed."
    ;;
  *)
    echo "Usage: $0 {install|start|stop|restart|status}" >&2
    exit 2
    ;;
esac
