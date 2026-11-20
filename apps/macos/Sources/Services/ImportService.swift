import AppKit
import WebKit

/// 首启/手动历史 ZIP 导入：原生选择文件并分块喂给网页的 window.deepDeskHistoryImport，
/// 网页用上游合并导入逻辑入库后通过 import.reportResult 回报结果。
/// 与 DeepDesk Windows 版首启向导行为对齐（默认合并导入，绝不覆盖既有会话）。
@MainActor
final class ImportService: NSObject {
    static let maxArchiveBytes = 512 * 1024 * 1024
    private static let chunkBytes = 4 * 1024 * 1024

    struct ImportResult {
        var success: Bool
        var imported: Int
        var skipped: Int
        var error: String?
    }

    private var resultContinuation: CheckedContinuation<ImportResult, Never>?
    private var resultTask: Task<Void, Never>?

    /// 选择 ZIP 并驱动网页导入；返回是否实际发起了导入（用户取消返回 false）。
    func pickAndImport(into webView: WKWebView) async throws -> Bool {
        let panel = NSOpenPanel()
        panel.title = "选择 DeepSeek 历史导出 ZIP"
        panel.allowedContentTypes = [.zip]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        let response = panel.runModal()
        guard response == .OK, let url = panel.url else { return false }

        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        let size = (attributes[.size] as? NSNumber)?.intValue ?? 0
        guard size > 0, size <= Self.maxArchiveBytes else {
            throw BridgeError.invalidParameter("ZIP 文件大小超出限制（最大 512 MB）。")
        }
        // 读取期间保留扩展名校验，防止伪装成 zip 的其他内容进入网页导入通道
        guard url.pathExtension.lowercased() == "zip" else {
            throw BridgeError.invalidParameter("仅支持 .zip 历史导出文件。")
        }

        let name = url.lastPathComponent
        let beginScript = "return window.deepDeskHistoryImport?.begin(name, totalBytes) ?? false"
        let beginValue = try await webView.callAsyncJavaScript(
            beginScript,
            arguments: ["name": name, "totalBytes": size],
            in: nil,
            contentWorld: .page
        )
        guard beginValue as? Bool == true else {
            throw BridgeError.invalidParameter("网页拒绝了这次导入（文件名或大小不合规）。")
        }

        let fileHandle = try FileHandle(forReadingFrom: url)
        defer { try? fileHandle.close() }
        var offset = 0
        while offset < size {
            let chunk = (try? fileHandle.read(upToCount: Self.chunkBytes)) ?? Data()
            if chunk.isEmpty { break }
            offset += chunk.count
            let appendScript = "return window.deepDeskHistoryImport?.append(base64) ?? false"
            let appendValue = try await webView.callAsyncJavaScript(
                appendScript,
                arguments: ["base64": chunk.base64EncodedString()],
                in: nil,
                contentWorld: .page
            )
            guard appendValue as? Bool == true else {
                _ = try? await webView.callAsyncJavaScript(
                    "window.deepDeskHistoryImport?.cancel()",
                    arguments: [:],
                    in: nil,
                    contentWorld: .page
                )
                throw BridgeError.invalidParameter("导入数据传输中断，请重试。")
            }
        }

        // 网页 finish() 完成后经 import.reportResult 回报；watchdog 超时兜底避免悬挂
        let watchdog = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 600 * 1_000_000_000)
            self?.reportResult(success: false, imported: 0, skipped: 0, error: "导入超时，请重试。")
        }
        let result = await withCheckedContinuation { (continuation: CheckedContinuation<ImportResult, Never>) in
            self.resultContinuation = continuation
            Task { @MainActor in
                try? await webView.callAsyncJavaScript(
                    "await window.deepDeskHistoryImport?.finish()",
                    arguments: [:],
                    in: nil,
                    contentWorld: .page
                )
            }
        }
        watchdog.cancel()
        guard result.success else {
            throw BridgeError.invalidParameter(result.error ?? "导入失败。")
        }
        return true
    }

    func reportResult(success: Bool, imported: Int, skipped: Int, error: String?) {
        let continuation = resultContinuation
        resultContinuation = nil
        continuation?.resume(returning: ImportResult(
            success: success,
            imported: imported,
            skipped: skipped,
            error: error
        ))
    }
}
