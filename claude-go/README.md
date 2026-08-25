# claude-go

一个命令让 Claude Code 使用任意 OpenAI 兼容后端——OpenCode Go、DeepSeek 官方 API 都只是配置里的一条档案，无需关心背后是哪家服务。

```sh
claude-go                # 用默认模型进入 Claude Code
claude-go --model ds     # 切到另一个模型档案
claude-go balance        # 查 DeepSeek 账户余额
```

> 本工具是 `claude-ds` + `claude-go` 两个旧工具的合并体：启动器统一走本地协议转换代理，余额查询并入为子命令。macOS 菜单栏余额 App 保留在 [DeepSeekUsage/](../DeepSeekUsage/)。

## 工作原理

```text
Claude Code
  -> http://127.0.0.1:<随机端口>/v1/messages     （Anthropic Messages 格式）
  -> claude-go 本地协议转换                       （按所选档案决定上游与密钥）
  -> 上游 OpenAI 兼容接口                          （OpenCode Go / DeepSeek 官方 / 其他）
```

每次启动临时起一个仅监听 `127.0.0.1` 的转换服务，退出 Claude Code 后自动关闭。

## 要求

- macOS、Linux 或 WSL
- Node.js 20+
- 已安装并可直接运行的 `claude` 命令
- 对应服务的账号与 API Key

## 安装

```sh
chmod +x install.sh claude-go
./install.sh
```

安装器把命令复制到 `~/.local/bin/claude-go`（已有同名先备份），并检查 Node 与 Claude Code。

自检：

```sh
claude-go doctor
```

## 配置文件：一份配置，多个模型

配置文件位于 `~/.config/claude-go/config.json`（或环境变量 `CLAUDE_GO_CONFIG` 指向任意路径）。不写配置也能用（内置默认 `deepseek-v4-flash` + 环境变量 Key）。要配置多个模型：

```sh
mkdir -p ~/.config/claude-go
cp config.example.json ~/.config/claude-go/config.json
chmod 600 ~/.config/claude-go/config.json
```

```json
{
  "default": "flash",
  "models": {
    "flash": { "model": "deepseek-v4-flash" },
    "pro":   { "model": "deepseek-v4-pro", "api_key": "sk-..." },
    "ds-chat": {
      "model": "deepseek-chat",
      "base_url": "https://api.deepseek.com",
      "api_key_file": "~/.config/deepseek/api_key"
    }
  }
}
```

每个档案的字段都是可选的：

| 字段 | 说明 | 缺省 |
|------|------|------|
| `model` | 发给上游的模型名 | `deepseek-v4-flash` |
| `api_key` | 内联密钥 | 依次回退：`api_key_file` → 环境变量 `OPENCODE_API_KEY` |
| `api_key_file` | 密钥文件路径（支持 `~`） | —— |
| `base_url` | 任意 OpenAI 兼容端点；缺 `/chat/completions` 时自动补全 | OpenCode Go 官方端点 |

**不区分服务商的关键就在 `base_url`**：OpenCode Go 和 DeepSeek 官方 API 都是 OpenAI 兼容接口，各写一条档案即可自由切换。

## 选择模型

三种方式（优先级从高到低）：

```sh
# 1. 命令行参数（仅当值是配置里的档案名时才拦截，否则原样透传给 Claude Code）
claude-go --model ds-chat
claude-go -m pro

# 2. 环境变量
CLAUDE_GO_MODEL=pro claude-go

# 3. 都不指定 → 配置里的 "default" 档案（没有配置则内置默认）
claude-go
```

## 查询 DeepSeek 余额

```sh
$ claude-go balance
================ DeepSeek 账户余额 ================
账户状态  : ✅ 可用
币种      : CNY
总余额    : ¥8.52
充值余额  : ¥8.52
赠送余额  : ¥0.00
===================================================

$ claude-go balance --raw     # 原始 JSON
```

Key 读取顺序：环境变量 `DEEPSEEK_API_KEY` → `~/.config/deepseek/api_key` → `~/.config/deepseek/token`（仅识别 `sk-` 开头，兼容旧版）。

### macOS 菜单栏余额 App

独立的常驻菜单栏应用，鼠标悬停看总余额、点击展开详情、每 5 分钟自动刷新：

```sh
cd DeepSeekUsage && ./build.sh          # 首次构建
open DeepSeekUsage/DeepSeekUsage.app    # 启动
```

## 安全设计

- 每档案的 Key 只由父进程读取，仅发送到该档案的 `base_url`
- 启动 Claude Code 前会从子进程环境中移除 `OPENCODE_API_KEY`，避免 Claude Code 的 Shell 工具直接继承真实 Key
- 本地代理使用每次启动随机生成的临时令牌，并仅监听回环地址
- 支持文本、流式输出、并行工具调用、工具结果和非流式响应；Anthropic 的提示词缓存控制等无法等价转换的字段会被安全忽略或降级

## 从旧版迁移

| 旧用法 | 新用法 |
|--------|--------|
| `claude-ds`（DeepSeek 官方后端） | `claude-go --model ds-chat`（档案名自取） |
| `claude-ds balance` | `claude-go balance` |
| `claude-go`（OpenCode Go） | 不变，或显式 `claude-go --model flash` |
| `~/.config/deepseek/api_key` | 继续有效，档案里用 `"api_key_file"` 引用即可 |

旧的 `claude-ds` 命令与 vendor/deepclaude 依赖已删除，统一走本工具。

## 开发验证

零第三方运行时依赖：

```sh
npm test
```

测试使用本地模拟服务，不会读取真实 API Key，也不会消耗任何额度。
