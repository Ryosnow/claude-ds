# claude-ds · claude-go

让 Claude Code 接入 DeepSeek 系后端的一对**相互独立**的工具，按你想用的服务二选一（或都装）：

| | 🤖 **claude-ds** | ⚡ **claude-go** |
|---|---|---|
| 所在目录 | [`claude-ds/`](claude-ds/) | [`claude-go/`](claude-go/) |
| 用的服务 | DeepSeek 官方 API | OpenCode Go 套餐 |
| 模型 | DeepSeek V4 Pro（via [deepclaude](https://github.com/aattaran/deepclaude)） | 多模型可配置（默认 `deepseek-v4-flash`），见 `config.example.json` |
| API Key | `DEEPSEEK_API_KEY` → `~/.config/deepseek/api_key` | `OPENCODE_API_KEY` 环境变量，或配置文件按模型指定 |
| 额外能力 | 🖥️ macOS 菜单栏余额 App + 🐚 终端余额查询 CLI | 本地协议转换代理（零依赖、仅回环监听） |
| 运行依赖 | bash / curl / Claude Code（菜单栏 App 需 macOS） | Node.js 20+ / Claude Code |
| 详细文档 | [claude-ds/README.md](claude-ds/README.md) | [claude-go/README.md](claude-go/README.md) |

> **怎么选？**
> - 有 DeepSeek 官方账号、想按量付费并随时看余额 → 装 **claude-ds**
> - 有 OpenCode Go 订阅、想要 flash 快速模型或多模型切换 → 装 **claude-go**
> - 两者互不干扰：API Key 各自独立、命令名不同、可同时安装。

---

## 🚀 claude-ds 使用方法

```bash
# 1. 安装（在 claude-ds/ 目录内执行）
cd claude-ds
./install.sh            # 自动克隆 deepclaude、构建菜单栏 App、软链到 ~/.local/bin

# 2. 配置 API Key
mkdir -p ~/.config/deepseek
echo 'sk-你的key' > ~/.config/deepseek/api_key
chmod 600 ~/.config/deepseek/api_key

# 3. 自检 + 使用
claude-ds doctor        # 自检环境
claude-ds               # 菜单栏余额窗口 + 进入 Claude Code（DeepSeek 后端）
claude-ds balance       # 仅在终端查一次余额
```

更多子命令与 FAQ 见 [claude-ds/README.md](claude-ds/README.md)。

---

## ⚡ claude-go 使用方法

```bash
# 1. 安装（在 claude-go/ 目录内执行）
cd claude-go
chmod +x install.sh claude-go
./install.sh            # 复制到 ~/.local/bin/claude-go（已有同名先备份）

# 2. 配置 API Key
export OPENCODE_API_KEY="你的 OpenCode Go API Key"

# 3. 自检 + 使用
claude-go doctor        # 自检环境、显示配置的模型档案
claude-go               # 进入 Claude Code（默认 deepseek-v4-flash 后端）
claude-go --model pro   # 用配置文件里的 pro 档案启动
claude-go -p "解释这个项目"   # 参数原样透传给 claude
```

多模型配置（`~/.config/claude-go/config.json`）与安全设计见 [claude-go/README.md](claude-go/README.md)。

---

## 📂 仓库结构

```
.
├── README.md            # 本文件：总览与选型
├── claude-ds/           # 工具一：DeepSeek 官方后端 + 余额套件（独立安装）
└── claude-go/           # 工具二：OpenCode Go 后端代理（独立安装）
```

两个工具各自带有 README 与安装脚本，单独克隆任一目录也能用。
