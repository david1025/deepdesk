import AppKit
import WebKit

/// Native Bridge v1。入站固定白名单（contracts/bridge-v1.d.ts / docs/09-bridge-contract.md）：
/// 仅主 frame 且来源为 Bundle 内 Web/ 目录的消息可调用；参数强校验；
/// 不提供任何 shell/任意路径读写能力；密钥永不回传 JS。
@MainActor
final class NativeBridge: NSObject, WKScriptMessageHandlerWithReply {
    private let environment: AppEnvironment
    private weak var webView: WKWebView?
    private var importInFlight = false

    init(environment: AppEnvironment, webView: WKWebView?) {
        self.environment = environment
        self.webView = webView
        super.init()
    }

    func attachWebView(_ view: WKWebView) {
        self.webView = view
    }

    // MARK: - 入口

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard isTrusted(message) else {
            DiagnosticsService.shared.log(.warn, "bridge", "rejected untrusted origin")
            reply(failure: ["code": "untrusted-origin", "message": "来源不受信任。"], replyHandler)
            return
        }
        guard let body = message.body as? [String: Any],
              let method = body["method"] as? String,
              method.count <= 64 else {
            DiagnosticsService.shared.log(.warn, "bridge", "rejected invalid request body")
            reply(failure: ["code": "invalid-request", "message": "请求格式无效。"], replyHandler)
            return
        }
        let params = body["params"] as? [String: Any] ?? [:]
        Task { @MainActor in
            do {
                let data = try await self.dispatch(method: method, params: params)
                replyHandler(["ok": true, "data": data], nil)
            } catch let error as BridgeError {
                DiagnosticsService.shared.log(.warn, "bridge",
                                              "method=\(method) rejected code=\(error.payload["code"] as? String ?? "?")")
                reply(failure: error.payload, replyHandler)
            } catch let error as ApiNetworkService.NativeApiError {
                let payload = error.payload
                DiagnosticsService.shared.log(.warn, "network",
                                              "operation=\(method) status=\(payload["status"] as? Int ?? 0) code=\(payload["code"] as? String ?? "?")")
                reply(failure: payload, replyHandler)
            } catch {
                // 不把 Keychain/底层原始错误细节回传前端
                DiagnosticsService.shared.log(.error, "bridge",
                                              "method=\(method) failed type=\(String(describing: type(of: error)))")
                reply(failure: ["code": "internal-error", "message": "原生操作失败。"], replyHandler)
            }
        }
    }

    private func reply(failure payload: [String: Any], _ replyHandler: @escaping (Any?, String?) -> Void) {
        replyHandler(["ok": false, "error": payload], nil)
    }

    private func isTrusted(_ message: WKScriptMessage) -> Bool {
        guard message.frameInfo.isMainFrame,
              let url = message.frameInfo.request.url,
              url.isFileURL,
              let root = Bundle.main.resourceURL?
                .appendingPathComponent("Web", isDirectory: true).standardizedFileURL else {
            return false
        }
        return url.standardizedFileURL.path.hasPrefix(root.path + "/")
    }

    // MARK: - 白名单分发

    private func dispatch(method: String, params: [String: Any]) async throws -> Any {
        switch method {
        // ---- 应用 ----
        case "app.getInfo":
            return ["platform": "macos", "version": environment.version,
                    "build": environment.build, "bridgeVersion": 1]
        case "app.openExternal":
            guard let raw = params["url"] as? String,
                  let components = URLComponents(string: raw),
                  components.scheme == "https" || components.scheme == "http",
                  components.host != nil,
                  (components.user ?? "").isEmpty,
                  (components.password ?? "").isEmpty else {
                throw BridgeError.invalidParameter("仅允许打开 HTTP/HTTPS 链接。")
            }
            let url = URL(string: raw)!
            NSWorkspace.shared.open(url)
            return ["opened": true]
        case "app.loginItem.get":
            return ["enabled": environment.loginItem.isEnabled]
        case "app.loginItem.set":
            guard let enabled = params["enabled"] as? Bool else {
                throw BridgeError.invalidParameter("enabled 必须为布尔值")
            }
            try environment.loginItem.setEnabled(enabled)
            return ["enabled": environment.loginItem.isEnabled]
        case "window.new":
            environment.openNewWindow()
            return ["opened": true]
        case "window.setTitle":
            guard let title = params["title"] as? String else {
                throw BridgeError.invalidParameter("title 无效")
            }
            let cleaned = String(title.filter { !$0.isNewline && !$0.isControlLike }.prefix(120))
            webView?.window?.title = cleaned
            return ["updated": true]
        // ---- 主题 ----
        case "system.getTheme":
            return ["theme": environment.theme.themeName]
        case "system.themeChanged":
            let theme = params["theme"] as? String ?? ""
            let preference = params["preference"] as? String ?? "system"
            guard theme == "dark" || theme == "light" else {
                throw BridgeError.invalidParameter("theme 无效")
            }
            environment.theme.applyWebReported(theme: theme, preference: preference)
            return ["acknowledged": true]
        // ---- 密钥（只写/查/删，不读回 JS）----
        case "security.key.exists":
            return ["exists": environment.keychain.exists()]
        case "security.key.save":
            guard let key = params["key"] as? String, !key.isEmpty, key.count <= 4096 else {
                throw BridgeError.invalidParameter("API Key 无效")
            }
            try environment.keychain.save(key)
            return ["saved": true]
        case "security.key.delete":
            try environment.keychain.delete()
            return ["deleted": true]
        // ---- 网络（Keychain 密钥仅原生持有）----
        case "network.request":
            guard let operation = params["operation"] as? String else {
                throw BridgeError.invalidParameter("operation 无效")
            }
            let payload = params["payload"] as? [String: Any] ?? [:]
            return try await environment.network.request(operation: operation, payload: payload)
        case "network.stream.start":
            guard let body = params["body"] as? [String: Any] else {
                throw BridgeError.invalidParameter("body 无效")
            }
            let beta = (params["beta"] as? Bool) ?? false
            return try startStream(body: body, beta: beta)
        case "network.stream.cancel":
            guard let streamId = params["streamId"] as? String else {
                throw BridgeError.invalidParameter("streamId 无效")
            }
            environment.network.cancelStream(id: streamId)
            return ["cancelled": true]
        case "network.upload.begin":
            guard let operation = params["operation"] as? String,
                  let name = params["name"] as? String,
                  let mime = params["mime"] as? String else {
                throw BridgeError.invalidParameter("上传参数无效")
            }
            let size = (params["size"] as? NSNumber)?.intValue ?? 0
            let purpose = params["purpose"] as? String
            let uploadId = try environment.network.beginUpload(
                operation: operation, name: name, mime: mime, size: size, purpose: purpose
            )
            return ["uploadId": uploadId]
        case "network.upload.append":
            guard let uploadId = params["uploadId"] as? String,
                  let base64 = params["base64"] as? String, base64.count <= 6 * 1024 * 1024 else {
                throw BridgeError.invalidParameter("上传分块无效")
            }
            try environment.network.appendUpload(id: uploadId, base64: base64)
            return ["appended": true]
        case "network.upload.finish":
            guard let uploadId = params["uploadId"] as? String else {
                throw BridgeError.invalidParameter("uploadId 无效")
            }
            return try await environment.network.finishUpload(id: uploadId)
        case "network.upload.cancel":
            guard let uploadId = params["uploadId"] as? String else {
                throw BridgeError.invalidParameter("uploadId 无效")
            }
            environment.network.cancelUpload(id: uploadId)
            return ["cancelled": true]
        // ---- 历史导入 ----
        case "import.pickArchive":
            guard let webView, !importInFlight else {
                throw BridgeError.invalidParameter("已有导入正在进行。")
            }
            importInFlight = true
            defer { importInFlight = false }
            let started = try await environment.imports.pickAndImport(into: webView)
            return ["started": started]
        case "import.reportResult":
            let success = (params["success"] as? Bool) ?? false
            let imported = (params["imported"] as? NSNumber)?.intValue ?? 0
            let skipped = (params["skipped"] as? NSNumber)?.intValue ?? 0
            let error = params["error"] as? String
            environment.imports.reportResult(success: success, imported: imported, skipped: skipped, error: error)
            return ["reported": true]
        // ---- 更新 ----
        case "updater.check":
            environment.updates.checkForUpdates()
            return ["requested": true]
        // ---- 原生存储（T06：SQLite + blob + 迁移）----
        case "storage.getMode":
            return ["mode": try await environment.storage.getMode()]
        case "storage.stats":
            return try await environment.storage.stats()
        case "storage.listSummaries":
            return ["summaries": try await environment.storage.listSummaries()]
        case "storage.loadSession":
            guard let id = params["id"] as? String else {
                throw BridgeError.invalidParameter("id 无效")
            }
            return try await environment.storage.loadSession(id) ?? ["session": NSNull(), "revision": 0]
        case "storage.saveSession":
            guard let json = params["session"] as? String, json.count <= 48 * 1024 * 1024,
                  let fileIds = params["fileIds"] as? [String] else {
                throw BridgeError.invalidParameter("session 参数无效")
            }
            return try await environment.storage.saveSession(json: json, fileIds: fileIds)
        case "storage.renameSession":
            guard let id = params["id"] as? String, let title = params["title"] as? String, title.count <= 500 else {
                throw BridgeError.invalidParameter("参数无效")
            }
            return try await environment.storage.renameSession(id: id, title: title)
        case "storage.deleteSession":
            guard let id = params["id"] as? String else {
                throw BridgeError.invalidParameter("id 无效")
            }
            return try await environment.storage.deleteSession(id: id)
        case "storage.listSessionIds":
            return ["ids": try await environment.storage.listSessionIds()]
        case "storage.listFileIds":
            return ["ids": try await environment.storage.listFileIds()]
        case "storage.loadAllUsage":
            return ["records": try await environment.storage.loadAllUsage()]
        case "storage.loadFileMeta":
            guard let fileId = params["fileId"] as? String else {
                throw BridgeError.invalidParameter("fileId 无效")
            }
            return try await environment.storage.loadFileMeta(fileId: fileId)
        case "storage.blob.read":
            guard let fileId = params["fileId"] as? String,
                  let offset = (params["offset"] as? NSNumber)?.intValue,
                  let length = (params["length"] as? NSNumber)?.intValue else {
                throw BridgeError.invalidParameter("分块参数无效")
            }
            return try await environment.storage.readBlob(fileId: fileId, offset: offset, length: length)
        case "storage.blob.putBegin":
            guard let fileId = params["fileId"] as? String, let mime = params["mime"] as? String else {
                throw BridgeError.invalidParameter("参数无效")
            }
            try await environment.storage.blobPutBegin(fileId: fileId, mime: mime)
            return ["begun": true]
        case "storage.blob.putAppend":
            guard let fileId = params["fileId"] as? String,
                  let base64 = params["base64"] as? String, base64.count <= 6 * 1024 * 1024 else {
                throw BridgeError.invalidParameter("分块无效")
            }
            try await environment.storage.blobPutAppend(fileId: fileId, base64: base64)
            return ["appended": true]
        case "storage.blob.putFinish":
            guard let fileId = params["fileId"] as? String else {
                throw BridgeError.invalidParameter("fileId 无效")
            }
            return try await environment.storage.blobPutFinish(fileId: fileId)
        case "storage.blob.putCancel":
            guard let fileId = params["fileId"] as? String else {
                throw BridgeError.invalidParameter("fileId 无效")
            }
            try await environment.storage.blobPutCancel(fileId: fileId)
            return ["cancelled": true]
        case "storage.staging.clear":
            try await environment.storage.stagingClear()
            return ["cleared": true]
        case "storage.staging.addSession":
            guard let json = params["session"] as? String, json.count <= 48 * 1024 * 1024 else {
                throw BridgeError.invalidParameter("session 参数无效")
            }
            try await environment.storage.stagingAddSession(json: json)
            return ["added": true]
        case "storage.staging.putFileBegin":
            guard let fileId = params["fileId"] as? String, let mime = params["mime"] as? String else {
                throw BridgeError.invalidParameter("参数无效")
            }
            try await environment.storage.stagingPutFileBegin(fileId: fileId, mime: mime)
            return ["begun": true]
        case "storage.staging.putFileAppend":
            guard let fileId = params["fileId"] as? String,
                  let base64 = params["base64"] as? String, base64.count <= 6 * 1024 * 1024 else {
                throw BridgeError.invalidParameter("分块无效")
            }
            try await environment.storage.stagingPutFileAppend(fileId: fileId, base64: base64)
            return ["appended": true]
        case "storage.staging.putFileFinish":
            guard let fileId = params["fileId"] as? String else {
                throw BridgeError.invalidParameter("fileId 无效")
            }
            try await environment.storage.stagingPutFileFinish(fileId: fileId)
            return ["finished": true]
        case "storage.staging.updateFileTypes":
            guard let types = params["types"] as? [String: String] else {
                throw BridgeError.invalidParameter("types 无效")
            }
            try await environment.storage.stagingUpdateFileTypes(types)
            return ["updated": true]
        case "storage.staging.commitReplace":
            return ["summaries": try await environment.storage.stagingCommitReplace()]
        case "storage.staging.commitMerge":
            return try await environment.storage.stagingCommitMerge()
        case "storage.migration.begin":
            guard let sessions = (params["expectedSessions"] as? NSNumber)?.intValue,
                  let files = (params["expectedFiles"] as? NSNumber)?.intValue else {
                throw BridgeError.invalidParameter("预期条数无效")
            }
            try await environment.storage.migrationBegin(expectedSessions: sessions, expectedFiles: files)
            return ["begun": true]
        case "storage.migration.putSession":
            guard let json = params["session"] as? String, json.count <= 48 * 1024 * 1024,
                  let sha256 = params["sha256"] as? String, sha256.count == 64 else {
                throw BridgeError.invalidParameter("迁移参数无效")
            }
            try await environment.storage.migrationPutSession(json: json, sha256: sha256)
            return ["stored": true]
        case "storage.migration.putFileBegin":
            guard let fileId = params["fileId"] as? String, let mime = params["mime"] as? String else {
                throw BridgeError.invalidParameter("参数无效")
            }
            try await environment.storage.migrationPutFileBegin(fileId: fileId, mime: mime)
            return ["begun": true]
        case "storage.migration.putFileAppend":
            guard let fileId = params["fileId"] as? String,
                  let base64 = params["base64"] as? String, base64.count <= 6 * 1024 * 1024 else {
                throw BridgeError.invalidParameter("分块无效")
            }
            try await environment.storage.migrationPutFileAppend(fileId: fileId, base64: base64)
            return ["appended": true]
        case "storage.migration.putFileFinish":
            guard let fileId = params["fileId"] as? String else {
                throw BridgeError.invalidParameter("fileId 无效")
            }
            try await environment.storage.migrationPutFileFinish(fileId: fileId)
            return ["stored": true]
        case "storage.migration.commit":
            guard let sessions = (params["expectedSessions"] as? NSNumber)?.intValue,
                  let files = (params["expectedFiles"] as? NSNumber)?.intValue else {
                throw BridgeError.invalidParameter("预期条数无效")
            }
            return try await environment.storage.migrationCommit(expectedSessions: sessions, expectedFiles: files)
        case "storage.migration.abort":
            try await environment.storage.migrationAbort()
            return ["aborted": true]
        // ---- 局域网同步（发现仅展示；配对/增量同步为 V1 待完成项，见 docs/05-lan-sync.md）----
        case "sync.discover":
            return ["devices": environment.discovery.deviceCount, "paired": false]
        default:
            throw BridgeError.unknownMethod
        }
    }

    private func startStream(body: [String: Any], beta: Bool) throws -> Any {
        guard let webView else {
            throw BridgeError.invalidParameter("网页容器不可用")
        }
        let streamId = try environment.network.startStream(body: body, beta: beta) { [weak webView] streamId, event in
            DispatchQueue.main.async {
                guard let webView else { return }
                let detail: [String: Any]
                switch event {
                case .sse(let base64):
                    detail = ["streamId": streamId, "type": "sse", "payload": ["b64": base64]]
                case .complete:
                    detail = ["streamId": streamId, "type": "complete", "payload": [:] as [String: Any]]
                case .error(let payload):
                    detail = ["streamId": streamId, "type": "error", "payload": payload]
                case .cancelled:
                    detail = ["streamId": streamId, "type": "cancelled", "payload": [:] as [String: Any]]
                }
                Task {
                    try? await webView.callAsyncJavaScript(
                        "window.dispatchEvent(new CustomEvent('nativeStreamEvent', { detail }))",
                        arguments: ["detail": detail],
                        in: nil,
                        contentWorld: .page
                    )
                }
            }
        }
        return ["streamId": streamId]
    }
}

enum BridgeError: Error {
    case invalidParameter(String)
    case unknownMethod

    var payload: [String: Any] {
        switch self {
        case .invalidParameter(let message):
            return ["code": "INVALID_REQUEST", "message": message]
        case .unknownMethod:
            return ["code": "ACTION_NOT_ALLOWED", "message": "不支持的操作。"]
        }
    }
}

private extension Character {
    /// 默认可忽略/控制字符；用于 window.setTitle 清洗
    var isControlLike: Bool {
        let scalar = unicodeScalars.first
        return unicodeScalars.count == 1 && (scalar?.properties.isDefaultIgnorableCodePoint ?? false)
    }
}
