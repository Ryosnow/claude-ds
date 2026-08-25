#!/usr/bin/env bash
# 把 DeepSeekUsage.swift 编译并打包成可双击运行的 .app
# 用法: ./build.sh        生成 ./DeepSeekUsage.app
#       ./build.sh install  额外复制到 /Applications

set -euo pipefail

cd "$(dirname "$0")"

APP_NAME="DeepSeekUsage"
APP_DIR="${APP_NAME}.app"
CONTENTS="${APP_DIR}/Contents"
MACOS_DIR="${CONTENTS}/MacOS"
RES_DIR="${CONTENTS}/Resources"
BIN="${MACOS_DIR}/${APP_NAME}"
SRC="${APP_NAME}.swift"
BUNDLE_ID="local.rumor.deepseekusage"
VERSION="1.0.0"

echo "🧹 清理旧产物…"
rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$RES_DIR"

echo "🔨 编译 Swift 源码 ($SRC)…"
# -O 发布优化；最低部署目标 macOS 13（MenuBarExtra 要求）
swiftc -O -target arm64-apple-macos14 -parse-as-library \
    -framework AppKit -framework SwiftUI -framework Foundation \
    "$SRC" -o "$BIN"

echo "🖼️  复制资源文件…"
if [[ -f "deepseek.svg" ]]; then
    cp "deepseek.svg" "${RES_DIR}/deepseek.svg"
    echo "   ✓ deepseek.svg"
else
    echo "   ⚠️  未找到 deepseek.svg，将退回到 SF Symbol 占位"
fi

# 让 app 在菜单栏运行（无 Dock 图标、无主窗口）
cat > "${CONTENTS}/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>${APP_NAME}</string>
    <key>CFBundleDisplayName</key><string>DeepSeek Usage</string>
    <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
    <key>CFBundleVersion</key><string>${VERSION}</string>
    <key>CFBundleShortVersionString</key><string>${VERSION}</string>
    <key>CFBundleExecutable</key><string>${APP_NAME}</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
    <key>LSMinimumSystemVersion</key><string>14.0</string>
    <key>LSUIElement</key><true/>
    <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

echo "✍️  ad-hoc 代码签名（避免 Gatekeeper 拦截）…"
codesign --force --deep --sign - "$APP_DIR" >/dev/null 2>&1 || true

echo "✅ 构建完成: $(pwd)/${APP_DIR}"

if [[ "${1:-}" == "install" ]]; then
    echo "📦 复制到 /Applications …"
    rm -rf "/Applications/${APP_DIR}"
    cp -R "$APP_DIR" /Applications/
    echo "✅ 已安装到 /Applications/${APP_DIR}"
fi
