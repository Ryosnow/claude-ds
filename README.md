# claude-go

一个命令让 Claude Code 使用任意 OpenAI 兼容后端——**不需要区分是 DeepSeek 的 API 还是 OpenCode Go 的 API**，它们都是配置文件里的一条模型档案。

```sh
claude-go                  # 用默认模型进入 Claude Code
claude-go --model ds-chat  # 换个模型档案
claude-go balance          # 查 DeepSeek 账户余额
```

## 📂 目录结构

```
.
├── README.md                 # 本文件：总览
├── claude-go/                # 唯一工具：多模型启动器 + 协议转换代理 + balance
│   ├── claude-go.mjs         # 核心实现（零第三方依赖）
│   ├── config.example.json   # 多模型配置示例
│   ├── install.sh            # 安装到 ~/.local/bin
│   └── test/                 # node:test 测试套件
└── DeepSeekUsage/            # macOS 菜单栏余额 App（独立，可选）
    ├── DeepSeekUsage.swift
    ├── build.sh
    └── deepseek.svg
```

## 🚀 快速开始

### 1. 安装

```sh
cd claude-go
chmod +x install.sh claude-go
./install.sh              # 复制到 ~/.local/bin/claude-go（已有同名先备份）
claude-go doctor          # 自检 Node / Claude Code / 配置
```

### 2. 写配置文件（一份配置管所有后端）

```sh
mkdir -p ~/.config/claude-go
cp claude-go/config.example.json ~/.config/claude-go/config.json
chmod 600 ~/.config/claude-go/config.json
```

示例：OpenCode Go 和 DeepSeek 官方各一条档案——

```json
{
  "default": "flash",
  "models": {
    "flash": { "model": "deepseek-v4-flash", "api_key": "sk-你的OpenCodeGoKey" },
    "ds-chat": {
      "model": "deepseek-chat",
      "base_url": "https://api.deepseek.com",
      "api_key_file": "~/.config/deepseek/api_key"
    }
  }
}
```

- `base_url` 不写 `/chat/completions` 后缀会自动补全；不写则默认 OpenCode Go 端点
- Key 三选一：`api_key`（内联）→ `api_key_file`（文件）→ 环境变量 `OPENCODE_API_KEY`

完整字段说明见 [claude-go/README.md](claude-go/README.md)。

### 3. 使用

```sh
claude-go                    # 默认档案进入 Claude Code
claude-go --model ds-chat    # 用指定档案（-m 同理；未知值原样透传给 claude）
CLAUDE_GO_MODEL=pro claude-go
claude-go -p "解释这个项目"   # 其余参数原样透传给 claude
```

### 4. 查余额（可选）

```sh
claude-go balance        # 终端打印 DeepSeek 账户余额
claude-go balance --raw  # 原始 JSON
```

Key 自动读取 `DEEPSEEK_API_KEY` 或 `~/.config/deepseek/api_key`。菜单栏常驻版见 [DeepSeekUsage/](DeepSeekUsage/)（`./build.sh` 构建）。

## ❓ FAQ

**Q：为什么能同时支持 OpenCode Go 和 DeepSeek 官方？**
A：两者都提供 OpenAI 兼容的 Chat Completions 接口。claude-go 在本地把 Claude Code 的 Anthropic Messages 请求转换成 OpenAI 格式，按所选档案转发到对应 `base_url` 并使用对应密钥，返回时再转换回 Anthropic 流式协议。

**Q：之前装的 `claude-ds` 命令还能用吗？**
A：已删除并替换。旧 `claude-ds`（走 deepclaude）的等价新用法是配置一条 DeepSeek 官方档案；旧 `claude-ds balance` 变成 `claude-go balance`。

**Q：API Key 安全吗？**
A：Key 只存在本地（内联在配置或独立文件），仅由父进程读取并只发送到该档案的 `base_url`；启动子进程前会从环境移除真实 Key；本地代理仅监听回环地址且使用一次性随机令牌。
