# claude-go

让 Claude Code 使用 OpenCode Go 套餐中的 `deepseek-v4-flash`。唯一必填配置是：

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

- API Key 只由 `claude-go` 父进程读取，并仅发送到 `https://opencode.ai/zen/go/v1/chat/completions`。
- 启动 Claude Code 前会从子进程环境中移除 `OPENCODE_API_KEY`，避免 Claude Code 的 Shell 工具直接继承真实 Key。
- 本地代理使用每次启动随机生成的临时令牌，并仅监听回环地址。
- 模型固定为 `deepseek-v4-flash`，包括 Claude Code 的 Opus、Sonnet、Haiku 与子代理模型映射。
- 支持文本、流式输出、并行工具调用、工具结果和非流式响应。
- Anthropic 的提示词缓存控制、扩展思考签名和 DeepSeek 不支持的多模态能力无法完全等价转换；相关字段会被安全忽略或降级。

## 工作原理

```text
Claude Code
  -> http://127.0.0.1:<随机端口>/v1/messages
  -> claude-go 协议转换
  -> https://opencode.ai/zen/go/v1/chat/completions
  -> deepseek-v4-flash
```

## 开发验证

项目没有第三方运行时依赖：

```sh
npm test
```

测试使用本地模拟服务，不会读取真实 API Key，也不会消耗 OpenCode Go 额度。
