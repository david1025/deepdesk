import Foundation

/// 原生 API 网络层。所有 DeepSeek 请求由原生 URLSession 发起，API Key 只从 Keychain 读取，
/// 不回传网页 JS（docs/01-technical-plan.md §7）。operations 白名单：
/// models / balance / files.delete / tts（network.request），
/// messages（network.stream.*），files.upload / asr（network.upload.*）。
final class ApiNetworkService: NSObject {

    static let apiBase = URL(string: "https://api.deepseek.com")!
    static let filesBetaHeader = "files-api-2025-04-14"
    private static let maxUploadBytes: Int = 64 * 1024 * 1024
    private static let maxAsrBytes: Int = 8 * 1024 * 1024
    private static let maxTtsPcmBytes: Int = 16 * 1024 * 1024
    private static let ttsChunkFlushInterval: TimeInterval = 0.03

    enum NativeApiError: Error {
        case invalidParameter(String)
        case http(status: Int, message: String)
        case network(String)
        case protocolError(String)
        case cancelled

        /// Bridge 回传给 JS 的错误体。有 status 时前端按 HTTP 分类（401/402/429/5xx），
        /// 没有时按网络错误处理，与上游 fetch 行为一致。
        var payload: [String: Any] {
            switch self {
            case .invalidParameter:
                return ["code": "INVALID_REQUEST", "message": "请求参数无效。"]
            case .http(let status, let message):
                return ["code": "API_REQUEST_FAILED", "message": message, "status": status]
            case .network(let message):
                return ["code": "NETWORK_FAILED", "message": message]
            case .protocolError(let message):
                return ["code": "API_PROTOCOL_ERROR", "message": message]
            case .cancelled:
                return ["code": "CANCELLED", "message": "请求已取消。"]
            }
        }
    }

    enum StreamEvent {
        case sse(base64: String)
        case complete
        case error(payload: [String: Any])
        case cancelled
    }

    // MARK: - 流

    final class SSEStream: NSObject, URLSessionDataDelegate {
        let id: String
        private let keychain: KeychainService
        private let onEvent: (StreamEvent) -> Void
        private var task: URLSessionDataTask?
        private var pendingData = Data()
        private var flushScheduled = false
        private var isHttpError = false
        private var errorBody = Data()
        private var completed = false
        private let stateQueue = DispatchQueue(label: "com.deepseek.mac.stream-state")

        init(id: String, keychain: KeychainService, onEvent: @escaping (StreamEvent) -> Void) {
            self.id = id
            self.keychain = keychain
            self.onEvent = onEvent
        }

        func start(body: [String: Any], beta: Bool) throws {
            guard let key = try keychain.loadForNativeRequestsOnly() else {
                throw NativeApiError.http(status: 401, message: "API Key 无效或无权访问。")
            }
            guard JSONSerialization.isValidJSONObject(body),
                  let bodyData = try? JSONSerialization.data(withJSONObject: body) else {
                throw NativeApiError.invalidParameter("消息体无效")
            }
            var request = URLRequest(url: ApiNetworkService.apiBase.appendingPathComponent("anthropic/v1/messages"))
            request.httpMethod = "POST"
            request.setValue(key, forHTTPHeaderField: "x-api-key")
            if beta {
                request.setValue(ApiNetworkService.filesBetaHeader, forHTTPHeaderField: "anthropic-beta")
            }
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            request.httpBody = bodyData
            request.timeoutInterval = 300

            let session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
            self.task = session.dataTask(with: request)
            task?.resume()
        }

        func cancel() {
            task?.cancel()
        }

        private func emit(_ event: StreamEvent) {
            onEvent(event)
        }

        // MARK: URLSessionDataDelegate（delegateQueue 串行回调）

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                        didReceive response: URLResponse,
                        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
            let http = response as? HTTPURLResponse
            let status = http?.statusCode ?? 0
            let contentType = (http?.value(forHTTPHeaderField: "Content-Type") ?? "").lowercased()
            if status < 200 || status >= 300 {
                isHttpError = true
            } else if !contentType.contains("text/event-stream") {
                emit(.error(payload: NativeApiError.protocolError("服务端没有返回 SSE 流式响应。").payload))
                completed = true
                completionHandler(.cancel)
                return
            }
            completionHandler(.allow)
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
            if isHttpError {
                if errorBody.count < 1024 * 1024 {
                    errorBody.append(data)
                }
                return
            }
            pendingData.append(data)
            scheduleFlush()
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            guard !completed else { return }
            completed = true
            flushPending()
            if isHttpError {
                let status = (task.response as? HTTPURLResponse)?.statusCode ?? 500
                let message = Self.parseErrorMessage(errorBody) ?? "模型请求失败（HTTP \(status)）。"
                emit(.error(payload: NativeApiError.http(status: status, message: message).payload))
                return
            }
            if let error = error as? URLError {
                if error.code == .cancelled {
                    emit(.cancelled)
                } else {
                    emit(.error(payload: NativeApiError.network(Self.networkMessage(error)).payload))
                }
                return
            }
            if let error = error {
                emit(.error(payload: NativeApiError.network(error.localizedDescription).payload))
                return
            }
            emit(.complete)
        }

        private func scheduleFlush() {
            guard !flushScheduled else { return }
            flushScheduled = true
            DispatchQueue.main.asyncAfter(deadline: .now() + ApiNetworkService.ttsChunkFlushInterval) { [weak self] in
                self?.flushPending()
            }
        }

        private func flushPending() {
            guard !pendingData.isEmpty else { return }
            let chunk = pendingData
            pendingData = Data()
            emit(.sse(base64: chunk.base64EncodedString()))
        }

        static func parseErrorMessage(_ data: Data) -> String? {
            guard !data.isEmpty,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let error = json["error"] as? [String: Any],
                  let message = error["message"] as? String else { return nil }
            return message
        }

        static func networkMessage(_ error: URLError) -> String {
            switch error.code {
            case .timedOut:
                return "请求超时，请检查网络后重试。"
            case .notConnectedToInternet, .networkConnectionLost, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed:
                return "网络连接不可用，请检查网络或代理设置。"
            default:
                return "网络请求失败（\(error.code.rawValue)）。"
            }
        }
    }

    // MARK: - 分块上传暂存

    final class StagedUpload {
        let operation: String
        let name: String
        let mime: String
        let purpose: String?
        let limit: Int
        private(set) var data = Data()

        init(operation: String, name: String, mime: String, purpose: String?) {
            self.operation = operation
            self.name = name
            self.mime = mime
            self.purpose = purpose
            self.limit = operation == "asr"
                ? ApiNetworkService.maxAsrBytes
                : ApiNetworkService.maxUploadBytes
        }

        func append(base64: String) throws {
            guard let decoded = Data(base64Encoded: base64) else {
                throw NativeApiError.invalidParameter("上传分块编码无效")
            }
            guard data.count + decoded.count <= limit else {
                throw NativeApiError.invalidParameter("文件超过大小限制（\(limit / 1024 / 1024) MB）。")
            }
            data.append(decoded)
        }
    }

    // MARK: - 服务状态

    private let keychain: KeychainService
    private let stateQueue = DispatchQueue(label: "com.deepseek.mac.api-network")
    private var streams: [String: SSEStream] = [:]
    private var uploads: [String: StagedUpload] = [:]

    init(keychain: KeychainService) {
        self.keychain = keychain
        super.init()
    }

    // MARK: network.request（models / balance / files.delete / tts）

    func request(operation: String, payload: [String: Any]) async throws -> [String: Any] {
        guard let key = try keychain.loadForNativeRequestsOnly() else {
            throw NativeApiError.http(status: 401, message: "API Key 无效或无权访问。")
        }
        switch operation {
        case "models":
            return try await plainJSON(method: "GET", path: "models", headers: ["Authorization": "Bearer \(key)"], body: nil)
        case "balance":
            return try await plainJSON(method: "GET", path: "user/balance", headers: ["Authorization": "Bearer \(key)"], body: nil)
        case "files.delete":
            guard let fileId = payload["fileId"] as? String, !fileId.contains("/") else {
                throw NativeApiError.invalidParameter("fileId 无效")
            }
            let headers: [String: String] = ["x-api-key": key, "anthropic-beta": Self.filesBetaHeader]
            return try await plainJSON(
                method: "DELETE",
                path: "anthropic/v1/files/\(fileId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? fileId)",
                headers: headers,
                body: nil
            )
        case "tts":
            return try await synthesize(payload: payload, key: key)
        default:
            throw NativeApiError.invalidParameter("不支持的 operation：\(operation)")
        }
    }

    private func plainJSON(method: String, path: String, headers: [String: String], body: Data?) async throws -> [String: Any] {
        var request = URLRequest(url: Self.apiBase.appendingPathComponent(path))
        request.httpMethod = method
        request.httpBody = body
        request.timeoutInterval = 60
        for (field, value) in headers {
            request.setValue(value, forHTTPHeaderField: field)
        }
        let (data, response) = try await perform(request: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw Self.httpError(response: response, data: data)
        }
        guard let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw NativeApiError.protocolError("响应不是有效的 JSON。")
        }
        // 直接回传裸 JSON（与 Windows 宿主一致）：web 端按上游响应体解析（如 user/balance），
        // 此前的 {status, data} 包装体会让 balance_infos 解析落空，前端永远停在"正在查询余额…"。
        return json
    }

    private func synthesize(payload: [String: Any], key: String) async throws -> [String: Any] {
        guard let text = payload["text"] as? String, !text.isEmpty else {
            throw NativeApiError.invalidParameter("朗读文本为空。")
        }
        guard let voice = payload["voice"] as? String, voice == "stella" || voice == "tide" else {
            throw NativeApiError.invalidParameter("不支持的朗读音色。")
        }
        let body: [String: Any] = ["text": text, "voice_id": voice, "format": "pcm", "filter_markdown": true]
        guard JSONSerialization.isValidJSONObject(body), let bodyData = try? JSONSerialization.data(withJSONObject: body) else {
            throw NativeApiError.invalidParameter("朗读请求体无效")
        }
        var request = URLRequest(url: Self.apiBase.appendingPathComponent("v1/tools/tts"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = bodyData
        request.timeoutInterval = 180
        let (data, response) = try await perform(request: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw Self.httpError(response: response, data: data)
        }
        guard data.count > 0, data.count % 2 == 0 else {
            throw NativeApiError.protocolError("语音合成返回的 PCM 数据无效。")
        }
        return ["audioBase64": data.base64EncodedString(), "sampleRate": 24000]
    }

    private func perform(request: URLRequest) async throws -> (Data, URLResponse) {
        do {
            return try await URLSession.shared.data(for: request)
        } catch let error as URLError {
            if error.code == .cancelled { throw NativeApiError.cancelled }
            throw NativeApiError.network(SSEStream.networkMessage(error))
        } catch {
            throw NativeApiError.network(error.localizedDescription)
        }
    }

    static func httpError(response: URLResponse, data: Data) -> NativeApiError {
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let fallback = status == 401 || status == 403
            ? "API Key 无效或无权访问。"
            : "请求失败（HTTP \(status)）。"
        return .http(status: status, message: SSEStream.parseErrorMessage(data) ?? fallback)
    }

    // MARK: network.upload.*

    func beginUpload(operation: String, name: String, mime: String, size: Int, purpose: String?) throws -> String {
        let allowed = ["files.upload", "asr"]
        guard allowed.contains(operation) else {
            throw NativeApiError.invalidParameter("不支持的上传类型：\(operation)")
        }
        guard !name.isEmpty, name.count <= 255, !mime.isEmpty else {
            throw NativeApiError.invalidParameter("文件名或类型无效")
        }
        let uploadId = UUID().uuidString
        let staged = StagedUpload(operation: operation, name: sanitizeFilename(name), mime: mime, purpose: purpose)
        stateQueue.sync {
            uploads[uploadId] = staged
        }
        return uploadId
    }

    func appendUpload(id: String, base64: String) throws {
        let staged: StagedUpload? = stateQueue.sync { uploads[id] }
        guard let staged else { throw NativeApiError.invalidParameter("上传会话不存在或已结束") }
        try staged.append(base64: base64)
    }

    func finishUpload(id: String) async throws -> [String: Any] {
        let staged: StagedUpload? = stateQueue.sync {
            let value = uploads[id]
            uploads[id] = nil
            return value
        }
        guard let staged else { throw NativeApiError.invalidParameter("上传会话不存在或已结束") }
        guard let key = try keychain.loadForNativeRequestsOnly() else {
            throw NativeApiError.http(status: 401, message: "API Key 无效或无权访问。")
        }

        let boundary = "DeepSeekBoundary-\(UUID().uuidString)"
        var body = Data()
        func append(text: String) {
            body.append(Data(text.utf8))
        }
        if let purpose = staged.purpose, !purpose.isEmpty {
            append(text: "--\(boundary)\r\nContent-Disposition: form-data; name=\"purpose\"\r\n\r\n\(purpose)\r\n")
        }
        append(text: "--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(staged.name)\"\r\nContent-Type: \(staged.mime)\r\n\r\n")
        body.append(staged.data)
        append(text: "\r\n--\(boundary)--\r\n")

        let path = staged.operation == "asr" ? "v1/tools/asr" : "anthropic/v1/files"
        var request = URLRequest(url: Self.apiBase.appendingPathComponent(path))
        request.httpMethod = "POST"
        if staged.operation == "asr" {
            request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        } else {
            request.setValue(key, forHTTPHeaderField: "x-api-key")
            request.setValue(Self.filesBetaHeader, forHTTPHeaderField: "anthropic-beta")
        }
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        request.timeoutInterval = 600
        let (data, response) = try await perform(request: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw Self.httpError(response: response, data: data)
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NativeApiError.protocolError("上传响应不是有效的 JSON。")
        }
        if staged.operation == "asr" {
            guard let text = json["text"] as? String else {
                throw NativeApiError.protocolError("语音识别返回格式无效。")
            }
            return ["text": text]
        }
        return ["file": json]
    }

    func cancelUpload(id: String) {
        stateQueue.sync { _ = uploads.removeValue(forKey: id) }
    }

    private func sanitizeFilename(_ name: String) -> String {
        let cleaned = name
            .map { $0.isNewline || $0 == "\0" || $0 == "\"" ? " " : $0 }
            .reduce(into: "") { $0.append($1) }
        return cleaned.isEmpty ? "file" : String(cleaned.prefix(255))
    }

    // MARK: network.stream.*

    func startStream(body: [String: Any], beta: Bool, onEvent: @escaping (String, StreamEvent) -> Void) throws -> String {
        let streamId = UUID().uuidString
        let stream = SSEStream(id: streamId, keychain: keychain) { [weak self] event in
            onEvent(streamId, event)
            if Self.isTerminal(event) {
                self?.stateQueue.sync { _ = self?.streams.removeValue(forKey: streamId) }
            }
        }
        try stream.start(body: body, beta: beta)
        stateQueue.sync { streams[streamId] = stream }
        return streamId
    }

    func cancelStream(id: String) {
        let stream: SSEStream? = stateQueue.sync { streams[id] }
        stream?.cancel()
    }

    static func isTerminal(_ event: StreamEvent) -> Bool {
        switch event {
        case .complete, .error, .cancelled: return true
        case .sse: return false
        }
    }
}
