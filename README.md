# claude-ds — DeepSeek + Claude Code 一体化工具

集成三件套，一个 `claude-ds` 命令搞定：

| 组件 | 作用 |
|------|------|
| 🤖 **deepclaude** | 让 Claude Code 走 DeepSeek V4 Pro 后端（17× 便宜） |
| 🖥️ **DeepSeekUsage.app** | macOS 菜单栏常驻，鼠标悬停看余额，点击展开详情 |
| 🐚 **deepseek_usage.sh** | 命令行查询余额、自由调用 DeepSeek 官方 API |

三者**共用同一份 API Key**：`~/.config/deepseek/api_key`

---

## 🚀 快速开始

### 1. 一键安装

```bash
cd ~/scripts/deepseek-usage
./install.sh
```

`install.sh` 会自动：
- 克隆 `deepclaude` 到 `vendor/deepclaude/`
- 构建菜单栏 App（如未构建）
- 在 `~/.local/bin/claude-ds` 创建软链
- 检查 Claude Code 与 PATH，给出后续提示

### 2. 准备 API Key

到 <https://platform.deepseek.com/api_keys> 创建 API Key（`sk-xxxxx...`），然后：

```bash
mkdir -p ~/.config/deepseek
echo 'sk-你的key' > ~/.config/deepseek/api_key
chmod 600 ~/.config/deepseek/api_key
```

### 3. 确认 Claude Code 已装

```bash
claude --version    # 没有就装：npm install -g @anthropic-ai/claude-code
```

### 4. 自检

```bash
claude-ds doctor
```

全部 ✓ 即可使用。

---

## 🎯 命令一览

```bash
claude-ds              # 默认：启动菜单栏余额窗口 + 进入 Claude Code（DeepSeek 后端）
claude-ds usage        # 仅启动/聚焦菜单栏余额窗口
claude-ds stop-usage   # 退出菜单栏余额窗口
claude-ds balance      # 在终端打印一次余额
claude-ds doctor       # 自检环境、依赖、API Key
claude-ds update       # 更新 vendor/deepclaude
claude-ds help         # 帮助
```

**透传 deepclaude 参数**（非上述子命令一律透传）：

```bash
claude-ds --status              # 显示后端状态
claude-ds --backend or          # 用 OpenRouter 启动 Claude Code
claude-ds --backend anthropic   # 用原生 Anthropic 启动 Claude Code
claude-ds --cost                # 显示成本对比
```

---

## 🖥️ 菜单栏余额窗口

启动后**屏幕右上角菜单栏**会出现 DeepSeek 鲸鱼图标 🐳：

- **鼠标悬停** → tooltip 显示总余额（如 `DeepSeek — 总余额 ¥8.52`）
- **点击图标** → 弹出详情面板：账户状态、总余额、充值余额、赠送余额、刷新按钮
- **每 5 分钟自动刷新**

可独立使用：双击 `DeepSeekUsage/DeepSeekUsage.app`，或 `claude-ds usage`。

---

## 🐚 命令行查询

```bash
$ claude-ds balance
================ DeepSeek 账户余额 ================
账户状态  : ✅ 可用
币种      : CNY
总余额    : 8.52
充值余额  : 8.52
赠送余额  : 0.00
===================================================

$ claude-ds balance raw                            # 原始 JSON
$ claude-ds balance get /models                    # 自由调用任意 GET 接口
$ claude-ds balance post /xxx '{"foo":"bar"}'      # 自由调用任意 POST 接口
```

---

## 📂 目录结构

```
deepseek-usage/
├── README.md                     # 本文件
├── install.sh                    # 一键安装
├── claude-ds                     # 顶层调度命令（被软链到 ~/.local/bin/）
├── deepseek_usage.sh             # 余额查询 CLI
├── DeepSeekUsage/                # 菜单栏 App
│   ├── DeepSeekUsage.swift
│   ├── deepseek.svg
│   ├── build.sh
│   └── DeepSeekUsage.app
└── vendor/
    └── deepclaude/               # 上游开源项目（git clone）
        └── deepclaude.sh
```

---

## 🔐 配置读取优先级

`claude-ds` 启动时会按顺序加载并 `export DEEPSEEK_API_KEY`：

1. 环境变量 `DEEPSEEK_API_KEY`
2. 文件 `~/.config/deepseek/api_key`
3. 文件 `~/.config/deepseek/token`（**仅当内容是 `sk-` 开头**，兼容旧版）

---

## ❓ 常见问题

**Q：执行 `claude-ds` 报"未检测到 Claude Code"？**
A：先装 Claude Code：`npm install -g @anthropic-ai/claude-code`，需要 Node.js 18+（没有就 `brew install node`）。

**Q：`claude-ds doctor` 提示 DEEPSEEK_API_KEY 未配置？**
A：到 <https://platform.deepseek.com/api_keys> 创建 API Key，写入 `~/.config/deepseek/api_key`。

**Q：怎么换后端（OpenRouter / Fireworks / Anthropic）？**
A：`claude-ds --backend or`、`claude-ds --backend fw`、`claude-ds --backend anthropic`，分别需要 `OPENROUTER_API_KEY` / `FIREWORKS_API_KEY` / `ANTHROPIC_API_KEY` 环境变量。详见 deepclaude 仓库 README。

**Q：`claude-ds` 退出后菜单栏窗口还在吗？**
A：在。菜单栏 App 是独立进程，与 Claude Code 解耦。需要关闭可执行 `claude-ds stop-usage`。

**Q：`deepclaude` 升级了想同步？**
A：`claude-ds update` 会执行 `git pull`。

**Q：菜单栏看不到图标？**
A：可能被其他菜单栏图标挤到屏幕外。`pgrep -lf DeepSeekUsage` 确认进程存在；可装 [Bartender](https://www.macbartender.com) 管理。

**Q：API Key 安全吗？**
A：仅本地保存（`~/.config/deepseek/api_key`，权限 600），App/脚本仅直连 `api.deepseek.com`。Key 一旦泄露请到平台立即删除并重建。

---

## 🙋 修改与扩展

- **改菜单栏 App 图标**：替换 `DeepSeekUsage/deepseek.svg` 后 `cd DeepSeekUsage && ./build.sh`
- **改自动刷新间隔**：编辑 `DeepSeekUsage.swift` 中 `startAutoRefresh()` 的 `5 * 60`
- **加更多余额字段**：`DeepSeekUsage.swift` 的 `UsageView` 里照着 `row(...)` 补
- **加桌面通知**：扩展 `UsageStore.refresh()`，余额低于阈值时调 `NSUserNotification`

---

## 📜 版本

- **v2.0**：集成 deepclaude，新增 `claude-ds` 命令
- v1.1：切换到 DeepSeek 官方 API（永不过期）
- v1.0：浏览器登录态 token（已废弃）

---

## 🙏 致谢

- [aattaran/deepclaude](https://github.com/aattaran/deepclaude) — Claude Code DeepSeek 后端代理
