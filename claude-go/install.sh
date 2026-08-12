#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INSTALL_DIR=${CLAUDE_GO_INSTALL_DIR:-"$HOME/.local/bin"}
TARGET="$INSTALL_DIR/claude-go"
MODULE_TARGET="$INSTALL_DIR/claude-go.mjs"

if ! command -v node >/dev/null 2>&1; then
  echo "错误：未找到 Node.js，请先安装 Node.js 20+。" >&2
  exit 1
fi

NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "错误：claude-go 需要 Node.js 20+，当前为 $(node --version)。" >&2
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "错误：未找到 claude 命令，请先安装 Claude Code。" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
  BACKUP="$TARGET.backup.$(date +%Y%m%d%H%M%S)"
  cp -p "$TARGET" "$BACKUP"
  echo "已备份原命令到：$BACKUP"
fi

cp "$SCRIPT_DIR/claude-go.mjs" "$MODULE_TARGET"
chmod 755 "$MODULE_TARGET"
cp "$SCRIPT_DIR/claude-go" "$TARGET"
chmod 755 "$TARGET"

echo "已安装：$TARGET"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo "提示：$INSTALL_DIR 尚未在 PATH 中，请将下面一行加入你的 shell 配置："
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac
echo "接下来只需："
echo "  export OPENCODE_API_KEY=\"你的_OpenCode_Go_API_Key\""
echo "  claude-go doctor"
echo "  claude-go"
