import SwiftUI
import Foundation

// MARK: - Data Models

struct UsageData: Codable {
    let isAvailable: Bool
    let currency: String
    let totalBalance: String      // 总余额
    let grantedBalance: String    // 赠送余额
    let toppedUpBalance: String   // 充值余额

    static let empty = UsageData(
        isAvailable: false,
        currency: "CNY",
        totalBalance: "—",
        grantedBalance: "—",
        toppedUpBalance: "—"
    )
}

// MARK: - API Response (matches DeepSeek official /user/balance)

private struct BalanceResponse: Decodable {
    let is_available: Bool
    let balance_infos: [BalanceInfo]
}
private struct BalanceInfo: Decodable {
    let currency: String
    let total_balance: String
    let granted_balance: String
    let topped_up_balance: String
}

// MARK: - Service

enum FetchError: LocalizedError {
    case noToken
    case http(Int, String?)
    case auth(String)
    case decode(String)
    case network(String)

    var errorDescription: String? {
        switch self {
        case .noToken:
            return "未配置 API Key。请将 DeepSeek API Key 写入 ~/.config/deepseek/api_key，或设置环境变量 DEEPSEEK_API_KEY"
        case .http(let c, let body):
            if let b = body, !b.isEmpty { return "HTTP \(c)：\(b)" }
            return "HTTP \(c)"
        case .auth(let m): return "鉴权失败：\(m)。请检查 API Key 是否正确"
        case .decode(let m): return "解析失败：\(m)"
        case .network(let m): return "网络错误：\(m)"
        }
    }
}

@MainActor
final class UsageStore: ObservableObject {
    @Published var usage: UsageData = .empty
    @Published var lastUpdated: Date? = nil
    @Published var isLoading: Bool = false
    @Published var errorMessage: String? = nil

    // 新接口配置：使用官方 API + DEEPSEEK_API_KEY（永不过期）
    private let apiKeyPath = ("~/.config/deepseek/api_key" as NSString).expandingTildeInPath
    // 兼容旧文件名（之前用 token 文件名保存浏览器登录态 token）
    private let legacyTokenPath = ("~/.config/deepseek/token" as NSString).expandingTildeInPath
    private let url = URL(string: "https://api.deepseek.com/user/balance")!

    func loadApiKey() throws -> String {
        // 1. 环境变量优先
        if let env = ProcessInfo.processInfo.environment["DEEPSEEK_API_KEY"], !env.isEmpty {
            return env
        }
        // 2. ~/.config/deepseek/api_key
        if FileManager.default.fileExists(atPath: apiKeyPath),
           let data = try? String(contentsOfFile: apiKeyPath, encoding: .utf8) {
            let key = data.trimmingCharacters(in: .whitespacesAndNewlines)
            if !key.isEmpty { return key }
        }
        // 3. 兼容：旧文件 ~/.config/deepseek/token（如果其中存放的是 sk- 开头的 API key 也能用）
        if FileManager.default.fileExists(atPath: legacyTokenPath),
           let data = try? String(contentsOfFile: legacyTokenPath, encoding: .utf8) {
            let key = data.trimmingCharacters(in: .whitespacesAndNewlines)
            if !key.isEmpty { return key }
        }
        throw FetchError.noToken
    }

    func refresh() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            let apiKey = try loadApiKey()
            var req = URLRequest(url: url)
            req.httpMethod = "GET"
            req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
            req.setValue("application/json", forHTTPHeaderField: "Accept")
            req.timeoutInterval = 15

            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse else {
                throw FetchError.network("无 HTTP 响应")
            }
            if http.statusCode == 401 || http.statusCode == 403 {
                let body = String(data: data, encoding: .utf8) ?? ""
                throw FetchError.auth(body.isEmpty ? "HTTP \(http.statusCode)" : body)
            }
            if http.statusCode != 200 {
                let body = String(data: data, encoding: .utf8)
                throw FetchError.http(http.statusCode, body)
            }

            let decoded = try JSONDecoder().decode(BalanceResponse.self, from: data)
            guard let first = decoded.balance_infos.first else {
                throw FetchError.decode("balance_infos 为空")
            }

            self.usage = UsageData(
                isAvailable: decoded.is_available,
                currency: first.currency,
                totalBalance: first.total_balance,
                grantedBalance: first.granted_balance,
                toppedUpBalance: first.topped_up_balance
            )
            self.lastUpdated = Date()
        } catch let e as FetchError {
            self.errorMessage = e.errorDescription
        } catch {
            self.errorMessage = "未知错误：\(error.localizedDescription)"
        }
    }
}

// MARK: - Formatting helpers

func fmtMoney(_ s: String, currency: String = "CNY") -> String {
    let symbol = currency == "CNY" ? "¥" : (currency == "USD" ? "$" : "\(currency) ")
    if let d = Double(s) {
        return String(format: "\(symbol)%.2f", d)
    }
    return "\(symbol)\(s)"
}

// MARK: - View

struct UsageView: View {
    @ObservedObject var store: UsageStore

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Image(systemName: "creditcard")
                    .foregroundColor(.accentColor)
                Text("DeepSeek 余额")
                    .font(.headline)
                Spacer()
                if store.isLoading {
                    ProgressView().controlSize(.small)
                }
            }
            Divider()

            if let err = store.errorMessage {
                VStack(alignment: .leading, spacing: 6) {
                    Label("出错了", systemImage: "exclamationmark.triangle.fill")
                        .foregroundColor(.orange)
                    Text(err)
                        .font(.callout)
                        .foregroundColor(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                row("账户状态",
                    store.usage.isAvailable ? "✅ 可用" : "⛔️ 不可用",
                    valueColor: store.usage.isAvailable ? .green : .red)
                row("总余额", fmtMoney(store.usage.totalBalance, currency: store.usage.currency))
                row("充值余额", fmtMoney(store.usage.toppedUpBalance, currency: store.usage.currency))
                row("赠送余额", fmtMoney(store.usage.grantedBalance, currency: store.usage.currency))
            }

            Divider()
            HStack {
                if let t = store.lastUpdated {
                    Text("更新于 \(t, formatter: timeFormatter)")
                        .font(.caption)
                        .foregroundColor(.secondary)
                } else {
                    Text("尚未刷新")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                Spacer()
                Button {
                    Task { await store.refresh() }
                } label: {
                    Label("刷新", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .disabled(store.isLoading)
            }

            HStack {
                Button("打开 DeepSeek 平台") {
                    if let url = URL(string: "https://platform.deepseek.com") {
                        NSWorkspace.shared.open(url)
                    }
                }
                .buttonStyle(.borderless)
                .font(.caption)
                Spacer()
                Button("退出") {
                    NSApp.terminate(nil)
                }
                .buttonStyle(.borderless)
                .font(.caption)
                .foregroundColor(.red)
            }
        }
        .padding(14)
        .frame(width: 280)
    }

    private func row(_ key: String, _ value: String, valueColor: Color? = nil) -> some View {
        HStack {
            Text(key)
                .foregroundColor(.secondary)
                .font(.callout)
            Spacer()
            Text(value)
                .font(.system(.callout, design: .monospaced))
                .foregroundColor(valueColor ?? .primary)
                .textSelection(.enabled)
        }
    }
}

private let timeFormatter: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "MM-dd HH:mm:ss"
    return f
}()

// MARK: - Menu bar icon

/// 加载 bundle 中的 deepseek.svg，作为模板图（自动适配深浅色菜单栏）
@MainActor
private func loadMenuBarIcon() -> NSImage {
    let size = NSSize(width: 18, height: 18)
    if let url = Bundle.main.url(forResource: "deepseek", withExtension: "svg"),
       let img = NSImage(contentsOf: url) {
        img.size = size
        img.isTemplate = true   // 关键：作为模板图，菜单栏会自动反色
        return img
    }
    // Fallback：找不到 svg 时退回 SF Symbol
    let sym = NSImage(systemSymbolName: "creditcard", accessibilityDescription: "DeepSeek")
        ?? NSImage(size: size)
    sym.isTemplate = true
    return sym
}

/// Tooltip 文本（鼠标悬停在菜单栏图标上时显示）
@MainActor
private func menuBarTooltip(for store: UsageStore) -> String {
    if let err = store.errorMessage { return "DeepSeek — 出错：\(err)" }
    if store.lastUpdated == nil { return "DeepSeek — 加载中…" }
    if let d = Double(store.usage.totalBalance) {
        let symbol = store.usage.currency == "CNY" ? "¥" : (store.usage.currency == "USD" ? "$" : "")
        return String(format: "DeepSeek — 总余额 \(symbol)%.2f", d)
    }
    return "DeepSeek 余额"
}

// MARK: - App

@main
struct DeepSeekUsageApp: App {
    @StateObject private var store = UsageStore()
    // 自动刷新计时器：5 分钟
    @State private var timerTask: Task<Void, Never>? = nil

    var body: some Scene {
        MenuBarExtra {
            UsageView(store: store)
                .onAppear {
                    Task { await store.refresh() }
                    startAutoRefresh()
                    updateStatusItemTooltip()
                }
                .onChange(of: store.lastUpdated) { _, _ in updateStatusItemTooltip() }
                .onChange(of: store.errorMessage) { _, _ in updateStatusItemTooltip() }
        } label: {
            // 只显示 deepseek 图标，无文字
            Image(nsImage: loadMenuBarIcon())
        }
        .menuBarExtraStyle(.window)
    }

    /// 给 MenuBarExtra 的状态栏按钮设置鼠标悬停 tooltip
    private func updateStatusItemTooltip() {
        let tip = menuBarTooltip(for: store)
        for w in NSApp.windows {
            if let btn = findStatusButton(in: w.contentView) {
                btn.toolTip = tip
            }
        }
    }

    private func findStatusButton(in view: NSView?) -> NSButton? {
        guard let view = view else { return nil }
        if let btn = view as? NSButton { return btn }
        for sub in view.subviews {
            if let found = findStatusButton(in: sub) { return found }
        }
        return nil
    }

    private func startAutoRefresh() {
        timerTask?.cancel()
        timerTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 5 * 60 * 1_000_000_000)
                if Task.isCancelled { break }
                await store.refresh()
            }
        }
    }
}
