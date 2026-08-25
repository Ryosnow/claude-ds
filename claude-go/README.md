# claude-go

让 Claude Code 使用 OpenCode Go 套餐中的模型（默认 `deepseek-v4-flash`，可通过配置文件切换多个模型）。唯一必填配置是：

```sh
export OPENCODE_API_KEY="你的 OpenCode Go API Key"
```

`claude-go` 会在本机临时启动一个仅监听 `127.0.0.1` 的协议转换服务，把 Claude Code 的 Anthropic Messages 请求转换成 OpenCode Go 的 OpenAI-compatible Chat Completions 请求。退出 Claude Code 后，本地服务会自动关闭。

## 要求

- macOS、Linux 或 WSL
- Node.js 20+
- 已安装并可直接运行的 `claude` 命令
- 有效的 OpenCode Go 订阅与 API Key

## 安装

```sh
chmod +x install.sh claude-go
./install.sh
```

安装器默认把命令复制到 `~/.local/bin/claude-go`。如果该位置已经有同名文件，安装器会先创建带时间戳的备份。

然后配置唯一的环境变量：

```sh
export OPENCODE_API_KEY="你的 OpenCode Go API Key"
```

如需永久生效，可把上面这一行加入 `~/.zshrc`、`~/.bashrc` 或其他 shell 配置文件。不要把 API Key 提交到 Git。

## 配置文件：多模型支持（可选）

不写配置文件也能用（内置默认 `deepseek-v4-flash`）。想配置多个模型时，复制示例并编辑：

```sh
mkdir -p ~/.config/claude-go
cp config.example.json ~/.config/claude-go/config.json
chmod 600 ~/.config/claude-go/config.json
```

配置文件位置：`~/.config/claude-go/config.json`，或用环境变量 `CLAUDE_GO_CONFIG` 指向任意路径。

```json
{
  "default": "flash",
  "models": {
    "flash": { "model": "deepseek-v4-flash" },
    "pro":   { "model": "deepseek-v4-pro", "api_key": "sk-...", "base_url": "https://..." }
  }
}
```

每个模型档案的字段都是可选的：

| 字段 | 说明 | 缺省 |
|------|------|------|
| `model` | 发给上游的模型名 | `deepseek-v4-flash` |
| `api_key` | 该模型专用 Key | 回退到环境变量 `OPENCODE_API_KEY` |
| `base_url` | 该模型专用上游接口 | OpenCode Go 官方端点 |

## 选择模型

三种方式（优先级从高到低）：

```sh
# 1. 命令行参数（仅当值是配置里的档案名时才拦截，否则原样透传给 Claude Code）
claude-go --model pro
claude-go -m pro

# 2. 环境变量
CLAUDE_GO_MODEL=pro claude-go

# 3. 都不指定 → 用配置里的 "default" 档案（没有配置则用内置默认）
claude-go
```

自检时会打印配置文件状态和当前生效的模型：

```sh
claude-go doctor
```

## 使用

```sh
claude-go
```

Claude Code 的参数会原样透传：

```sh
claude-go -p "解释这个项目"
claude-go -c
claude-go --resume SESSION_ID
```

自检：

```sh
claude-go doctor
```

查看本工具帮助：

```sh
claude-go --claude-go-help
```

## 安全与兼容性

- API Key 优先读取所选模型档案里的 `api_key`，否则读环境变量 `OPENCODE_API_KEY`；只发送到该档案的 `base_url`（默认 `https://opencode.ai/zen/go/v1/chat/completions`）。
- 启动 Claude Code 前会从子进程环境中移除 `OPENCODE_API_KEY`，避免 Claude Code 的 Shell 工具直接继承真实 Key。
- 本地代理使用每次启动随机生成的临时令牌，并仅监听回环地址。
- 模型由配置决定（默认 `deepseek-v4-flash`），包括 Claude Code 的 Opus、Sonnet、Haiku 与子代理模型映射。
- 支持文本、流式输出、并行工具调用、工具结果和非流式响应。
- Anthropic 的提示词缓存控制、扩展思考签名和 DeepSeek 不支持的多模态能力无法完全等价转换；相关字段会被安全忽略或降级。

## 工作原理

```text
Claude Code
  -> http://127.0.0.1:<随机端口>/v1/messages
  -> claude-go 协议转换（按配置选择模型）
  -> https://opencode.ai/zen/go/v1/chat/completions
  -> deepseek-v4-flash / 配置的其他模型
```

## 开发验证

项目没有第三方运行时依赖：

```sh
npm test
```

测试使用本地模拟服务，不会读取真实 API Key，也不会消耗 OpenCode Go 额度。
