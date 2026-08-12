# claude-go 设计

## 目标与验收标准

用户只配置 `OPENCODE_API_KEY`，即可通过 `claude-go` 启动 Claude Code，并固定消费 OpenCode Go 的 `deepseek-v4-flash` 套餐额度。工具不持久化密钥、不要求第三方包，并能处理 Claude Code 的文本流与工具调用循环。

## 架构

一个 Node.js 入口同时承担启动器和临时本地网关。启动器监听随机回环端口，生成一次性本地令牌，设置 Claude Code 的网关与模型环境变量，然后启动系统中的 `claude`。网关接收 Anthropic Messages 请求，将系统提示、消息、工具定义、工具选择和采样参数转换为 OpenAI Chat Completions 格式，固定上游模型后发往 OpenCode Go。上游 SSE 被转换为 Anthropic 的 `message_start`、内容块、`message_delta` 和 `message_stop` 事件。Claude Code 退出后关闭网关。

真实 OpenCode Key 不传入 Claude Code 子进程。网关只监听 `127.0.0.1`，并验证随机本地令牌。上游错误会保留 HTTP 状态并转换成 Anthropic 错误结构。工具参数无效时会作为 `_raw_arguments` 包装，避免让 Claude Code 的流解析器直接崩溃。

## 验证

单元测试覆盖请求和非流式响应转换；集成测试用本地模拟 OpenCode 服务覆盖身份头、固定模型、文本 SSE、分片工具参数、停止原因和令牌计数。安装脚本检查 Node.js 与 Claude Code，并在覆盖旧命令前创建备份。
