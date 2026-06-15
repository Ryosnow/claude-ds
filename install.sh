#!/usr/bin/env bash
# install.sh — 安装 claude-ds 命令到系统 PATH
#
# 用法:
#   ./install.sh                  自动选择 ~/.local/bin（无需 sudo）
#   ./install.sh /usr/local/bin   指定安装目录（可能需要 sudo）

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
TARGET_BIN="${1:-$HOME/.local/bin}"
LINK="${TARGET_BIN}/claude-ds"
SOURCE="${ROOT}/claude-ds"

echo "🔍 检查环境…"

# 1. claude-ds 主脚本可执行
chmod +x "$SOURCE"
chmod +x "${ROOT}/deepseek_usage.sh" 2>/dev/null || true
chmod +x "${ROOT}/DeepSeekUsage/build.sh" 2>/dev/null || true
chmod +x "${ROOT}/vendor/deepclaude/deepclaude.sh" 2>/dev/null || true

# 2. vendor deepclaude（若没有）
if [ ! -d "${ROOT}/vendor/deepclaude/.git" ]; then
    echo "📦 克隆 deepclaude…"
    mkdir -p "${ROOT}/vendor"
    rm -rf "${ROOT}/vendor/deepclaude"
    git clone --depth 1 https://github.com/aattaran/deepclaude.git "${ROOT}/vendor/deepclaude"
    chmod +x "${ROOT}/vendor/deepclaude/deepclaude.sh"
else
    echo "✓ deepclaude 已 vendor"
fi

# 3. 构建菜单栏 App（如果还没构建）
if [ ! -d "${ROOT}/DeepSeekUsage/DeepSeekUsage.app" ]; then
    echo "🔨 构建菜单栏 App…"
    ( cd "${ROOT}/DeepSeekUsage" && ./build.sh )
else
    echo "✓ 菜单栏 App 已存在"
fi

# 4. 创建软链
mkdir -p "$TARGET_BIN"
ln -sf "$SOURCE" "$LINK"
echo "🔗 已创建软链: $LINK -> $SOURCE"

# 5. 检查 PATH
case ":$PATH:" in
    *":$TARGET_BIN:"*)
        echo "✓ $TARGET_BIN 已在 PATH 中"
        ;;
    *)
        echo ""
        echo "⚠️  $TARGET_BIN 不在 PATH 中。请把这一行加入 ~/.zshrc 或 ~/.bashrc："
        echo ""
        echo "    export PATH=\"$TARGET_BIN:\$PATH\""
        echo ""
        echo "然后执行: source ~/.zshrc"
        ;;
esac

# 6. 检查 Claude Code
echo ""
if command -v claude >/dev/null 2>&1; then
    echo "✓ Claude Code 已安装: $(claude --version 2>/dev/null | head -1)"
else
    echo "⚠️  Claude Code 未安装。运行以下命令安装："
    echo ""
    echo "    npm install -g @anthropic-ai/claude-code"
    echo ""
fi

# 7. 检查 API Key
if [ -n "${DEEPSEEK_API_KEY:-}" ] || [ -s "$HOME/.config/deepseek/api_key" ]; then
    echo "✓ DeepSeek API Key 已配置"
else
    echo "⚠️  尚未配置 DeepSeek API Key。运行："
    echo ""
    echo "    mkdir -p ~/.config/deepseek"
    echo "    echo 'sk-xxxxxxxx' > ~/.config/deepseek/api_key"
    echo "    chmod 600 ~/.config/deepseek/api_key"
    echo ""
fi

echo ""
echo "✅ 安装完成！试试这些命令："
echo "    claude-ds doctor       # 自检环境"
echo "    claude-ds usage        # 仅启动菜单栏余额窗口"
echo "    claude-ds balance      # 终端打印余额"
echo "    claude-ds              # 启动菜单栏 + 进入 Claude Code (DeepSeek)"
