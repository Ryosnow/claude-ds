#!/usr/bin/env bash
# DeepSeek 余额 / 用量查询脚本（官方 API 版本，永不过期）
# 用法:
#   ./deepseek_usage.sh                   查询账户余额 (默认)
#   ./deepseek_usage.sh balance           同上
#   ./deepseek_usage.sh raw               输出原始 JSON
#   ./deepseek_usage.sh get  <path>       自由调用任意 GET 接口
#                                         例: ./deepseek_usage.sh get /user/balance
#                                             ./deepseek_usage.sh get /models
#   ./deepseek_usage.sh post <path> '<json_body>'   自由调用任意 POST 接口
#
# API Key 读取顺序:
#   1) 环境变量 DEEPSEEK_API_KEY
#   2) ~/.config/deepseek/api_key 文件 (推荐, 权限 600)
#   3) ~/.config/deepseek/token   文件 (兼容旧路径)

set -euo pipefail

BASE_URL="https://api.deepseek.com"
API_KEY_FILE="${HOME}/.config/deepseek/api_key"
LEGACY_TOKEN_FILE="${HOME}/.config/deepseek/token"

# ---------- 读取 API Key ----------
if [[ -n "${DEEPSEEK_API_KEY:-}" ]]; then
    API_KEY="$DEEPSEEK_API_KEY"
elif [[ -f "$API_KEY_FILE" ]]; then
    API_KEY="$(tr -d ' \n\r' < "$API_KEY_FILE")"
elif [[ -f "$LEGACY_TOKEN_FILE" ]]; then
    API_KEY="$(tr -d ' \n\r' < "$LEGACY_TOKEN_FILE")"
else
    cat >&2 <<EOF
❌ 未找到 API Key。

请前往 https://platform.deepseek.com/api_keys 创建一个 API Key（sk- 开头），然后任选一种方式配置：

  方式 1（推荐，长期使用）：
    mkdir -p ~/.config/deepseek
    echo 'sk-xxxxxxxx' > $API_KEY_FILE
    chmod 600 $API_KEY_FILE

  方式 2（临时 / 一次性）：
    export DEEPSEEK_API_KEY='sk-xxxxxxxx'
EOF
    exit 1
fi

if [[ -z "$API_KEY" ]]; then
    echo "❌ API Key 为空" >&2
    exit 1
fi

# ---------- 通用请求函数 ----------
_request() {
    local method="$1"
    local path="$2"
    local body="${3:-}"

    local args=(
        -sS
        -X "$method"
        -H "Authorization: Bearer $API_KEY"
        -H "Accept: application/json"
    )
    if [[ -n "$body" ]]; then
        args+=(-H "Content-Type: application/json" --data "$body")
    fi
    curl "${args[@]}" "${BASE_URL}${path}"
}

# ---------- 美化输出（balance） ----------
_pretty_balance() {
    if ! command -v jq >/dev/null 2>&1; then
        cat
        return
    fi
    jq -r '
      .balance_infos[0] as $b |
      "================ DeepSeek 账户余额 ================",
      "账户状态  : \(if .is_available then "✅ 可用" else "⛔️ 不可用" end)",
      "币种      : \($b.currency)",
      "总余额    : \($b.total_balance)",
      "充值余额  : \($b.topped_up_balance)",
      "赠送余额  : \($b.granted_balance)",
      "==================================================="
    '
}

# ---------- 子命令分发 ----------
cmd="${1:-balance}"
case "$cmd" in
    balance|summary|"")
        _request GET "/user/balance" | _pretty_balance
        ;;
    raw)
        _request GET "/user/balance" | (command -v jq >/dev/null && jq . || cat)
        ;;
    get)
        path="${2:?用法: $0 get <path>}"
        _request GET "$path" | (command -v jq >/dev/null && jq . || cat)
        ;;
    post)
        path="${2:?用法: $0 post <path> <json_body>}"
        body="${3:-}"
        _request POST "$path" "$body" | (command -v jq >/dev/null && jq . || cat)
        ;;
    -h|--help|help)
        sed -n '2,17p' "$0"
        ;;
    *)
        echo "未知命令: $cmd" >&2
        echo "可用: balance | raw | get <path> | post <path> <json> | help" >&2
        exit 2
        ;;
esac
