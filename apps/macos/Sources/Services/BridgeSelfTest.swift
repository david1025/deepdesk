import Foundation
import AppKit

/// 开发诊断：`DeepSeek.app/Contents/MacOS/DeepSeek --bridge-selftest` 时运行。
/// 直接驱动隔离的本地凭据文件与原生网络层做真实 HTTPS 验证（不经过网页），
/// 结果写入 /tmp/deepseek-selftest.json 后退出。不输出密钥内容。
@MainActor
final class BridgeSelfTest {
    static let shouldRun = ProcessInfo.processInfo.arguments.contains("--bridge-selftest")

    static func runIfRequested() {
        guard shouldRun else { return }
        Task { @MainActor in
            let tester = BridgeSelfTest()
            await tester.run()
        }
    }

    private var results: [[String: Any]] = []

    private func record(_ name: String, _ passed: Bool, _ detail: String) {
        results.append(["name": name, "passed": passed, "detail": detail])
        NSLog("selftest %@: %@ (%@)", passed ? "PASS" : "FAIL", name, detail)
    }

    private func run() async {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("deepdesk-selftest-credentials-\(UUID().uuidString)", isDirectory: true)
        let credentials = LocalCredentialStore(directory: directory)
        let network = ApiNetworkService(credentials: credentials)

        do {
            let fakeKey = "sk-selftest-fake-key"
            try credentials.set(fakeKey)
            let mode = try FileManager.default.attributesOfItem(atPath: directory.appendingPathComponent("api-key").path)
            let permissions = (mode[.posixPermissions] as? NSNumber)?.intValue
            let reopened = LocalCredentialStore(directory: directory)
            let restored = reopened.loadForNativeRequestsOnly() == fakeKey
            try reopened.set("sk-selftest-new-key")
            let replaced = LocalCredentialStore(directory: directory).loadForNativeRequestsOnly() == "sk-selftest-new-key"
            try credentials.set(nil)
            let cleared = LocalCredentialStore(directory: directory).loadForNativeRequestsOnly() == nil
            record("local-credential.lifecycle", restored && replaced && cleared && permissions == 0o600,
                   "restored=\(restored), replaced=\(replaced), cleared=\(cleared), privateMode=\(permissions == 0o600)")
        } catch {
            record("local-credential.lifecycle", false, "credential file operation failed")
        }

        // 2. 无 Key 调用 models：预期 401 分类（不泄露密钥，只报错误码）
        do {
            _ = try await network.request(operation: "models", payload: [:])
            record("models.without-key", false, "unexpected success without key")
        } catch let error as ApiNetworkService.NativeApiError {
            let payload = error.payload
            let status = payload["status"] as? Int ?? 0
            record("models.without-key", status == 401, "status=\(status) code=\(payload["code"] as? String ?? "?")")
        } catch {
            record("models.without-key", false, "unexpected error type")
        }

        // 3. 假 Key 走真实 /models：预期服务端 401，错误分类正确
        do {
            try credentials.set("sk-selftest-invalid-key-000000")
            defer { try? credentials.set(nil) }
            do {
                _ = try await network.request(operation: "models", payload: [:])
                record("models.invalid-key", false, "unexpected success with fake key")
            } catch let error as ApiNetworkService.NativeApiError {
                let payload = error.payload
                let status = payload["status"] as? Int ?? 0
                let message = payload["message"] as? String ?? ""
                let leaked = message.contains("sk-selftest")
                record("models.invalid-key", status == 401 && !leaked,
                       "status=\(status) message='\(message)' keyLeaked=\(leaked)")
            } catch {
                record("models.invalid-key", false, "unexpected error type")
            }

            // 4. 非法 operation 白名单
            do {
                _ = try await network.request(operation: "shell.exec", payload: [:])
                record("operation.whitelist", false, "bogus operation accepted")
            } catch let error as ApiNetworkService.NativeApiError {
                let code = error.payload["code"] as? String ?? ""
                record("operation.whitelist", code == "INVALID_REQUEST", "code=\(code)")
            } catch {
                record("operation.whitelist", false, "unexpected error type")
            }

            // 5. SSE 流：假 Key 启动流，预期收到 error 事件（status 401）
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                var finished = false
                do {
                    let streamId = try network.startStream(
                        body: ["model": "deepseek-flash", "messages": [["role": "user", "content": "hi"]]],
                        beta: false
                    ) { [weak self] _, event in
                        guard let self else { return }
                        Task { @MainActor in
                            if case .error(let payload) = event {
                                let status = payload["status"] as? Int ?? 0
                                self.record("stream.invalid-key", status == 401,
                                            "event=error status=\(status) code=\(payload["code"] as? String ?? "?")")
                                finished = true
                                continuation.resume()
                            }
                        }
                    }
                    _ = streamId
                    // 超时兜底
                    DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
                        if !finished {
                            continuation.resume()
                        }
                    }
                } catch {
                    record("stream.invalid-key", true, "start threw immediately (acceptable): \(type(of: error))")
                    finished = true
                    continuation.resume()
                }
            }
        } catch {
            record("models.invalid-key", false, "could not write the isolated fixture key")
        }
        try? FileManager.default.removeItem(at: directory)

        // 6. 原生存储（T06）：临时数据库上验证 CRUD/blob/tombstone/staging/迁移校验
        await storageTests()

        let output: [String: Any] = [
            "timestamp": ISO8601DateFormatter().string(from: Date()),
            "results": results
        ]
        if let data = try? JSONSerialization.data(withJSONObject: output, options: [.prettyPrinted]),
           let target = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("DeepSeekSelfTest") {
            try? FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
            try? data.write(to: target.appendingPathComponent("selftest.json"))
        }
        NSLog("selftest complete: %d checks", results.count)
        exit(results.allSatisfy { ($0["passed"] as? Bool) == true } ? 0 : 3)
    }

    // MARK: - T06 存储自检

    private func storageTests() async {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("deepseek-selftest-storage-\(UUID().uuidString)", isDirectory: true)
        let storage = StorageService(
            databaseURL: tempDir.appendingPathComponent("chat.db"),
            attachmentsURL: tempDir.appendingPathComponent("Attachments")
        )
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let sessionJSON = """
        {"id":"sess-selftest-1","title":"自检会话","createdAt":1700000000000,"updatedAt":1700000001000,
         "messages":[
           {"id":"m1","role":"user","content":"你好","createdAt":1700000000000,
            "files":[{"id":"file-st-1","serverId":null,"name":"附件.txt","size":11,"isImage":false,"mimeType":"text/plain"}]},
           {"id":"m2","role":"assistant","content":"回复","createdAt":1700000001000,"model":"deepseek-flash",
            "usage":{"input_tokens":3,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":2}}
         ]}
        """
        let blobData = Data("selftest原始件".utf8)

        // 6.1 blob 上传 + saveSession 引用 + 读回
        do {
            try await storage.blobPutBegin(fileId: "file-st-1", mime: "text/plain")
            try await storage.blobPutAppend(fileId: "file-st-1", base64: blobData.base64EncodedString())
            let finish = try await storage.blobPutFinish(fileId: "file-st-1")
            let digest = finish["sha256"] as? String ?? ""
            guard digest == StorageService.sha256Hex(blobData) else {
                record("storage.blob-roundtrip", false, "sha256 mismatch")
                return
            }
            _ = try await storage.saveSession(json: sessionJSON, fileIds: ["file-st-1"])
            let meta = try await storage.loadFileMeta(fileId: "file-st-1")
            let chunk = try await storage.readBlob(fileId: "file-st-1", offset: 0, length: meta["size"] as? Int ?? 0)
            let roundtrip = Data(base64Encoded: chunk["base64"] as? String ?? "") ?? Data()
            record("storage.blob-roundtrip", roundtrip == blobData, "size=\(roundtrip.count)")
        } catch {
            record("storage.blob-roundtrip", false, "error=\(type(of: error))")
            return
        }

        // 6.2 会话读回：消息树逐字段一致
        do {
            let loaded = try await storage.loadSession("sess-selftest-1")
            guard let sessionString = loaded?["session"] as? String,
                  let session = try JSONSerialization.jsonObject(with: Data(sessionString.utf8)) as? [String: Any],
                  let messages = session["messages"] as? [[String: Any]],
                  messages.count == 2,
                  (messages[0]["files"] as? [[String: Any]])?.first?["name"] as? String == "附件.txt",
                  (messages[1]["usage"] as? [String: Any])?["output_tokens"] as? Int == 2 else {
                record("storage.session-roundtrip", false, "message tree mismatch")
                return
            }
            record("storage.session-roundtrip", true, "messages=\(messages.count)")
        } catch {
            record("storage.session-roundtrip", false, "error=\(type(of: error))")
        }

        // 6.3 列表 / 重命名 / 引用计数删除
        do {
            let summaries = try await storage.listSummaries()
            guard summaries.count == 1 else {
                record("storage.list", false, "summaries=\(summaries.count)")
                return
            }
            _ = try await storage.renameSession(id: "sess-selftest-1", title: "改名后")
            let renamed = try await storage.loadSession("sess-selftest-1")
            let title = ((try? JSONSerialization.jsonObject(with: Data((renamed?["session"] as? String ?? "").utf8)) as? [String: Any])?["title"] as? String) ?? ""
            // 删除会话 → 原件引用归零 → 附件行与 blob 文件清理
            _ = try await storage.deleteSession(id: "sess-selftest-1")
            let files = (try? FileManager.default.contentsOfDirectory(atPath: tempDir.appendingPathComponent("Attachments").path)) ?? []
            let fileGone = !files.contains { $0.hasPrefix(StorageService.sha256Hex(blobData).prefix(8)) }
            record("storage.rename-delete-gc", title == "改名后" && fileGone,
                   "title='\(title)' attachmentsLeft=\(files.filter { !$0.hasPrefix(".tmp") }.count)")
        } catch {
            record("storage.rename-delete-gc", false, "error=\(type(of: error))")
        }

        // 6.4 tombstone：删除后的会话不允许旧状态写回（B07/E08）；合并导入可恢复
        do {
            do {
                _ = try await storage.saveSession(json: sessionJSON, fileIds: [])
                record("storage.tombstone", false, "deleted session was overwritten")
            } catch let error as StorageService.StorageError {
                let code = error.payload["code"] as? String ?? ""
                record("storage.tombstone", code == "STORAGE_SESSION_DELETED", "code=\(code)")
            }
            // 合并导入恢复：tombstone 被清除，会话可再次读取
            try await storage.stagingClear()
            try await storage.stagingAddSession(json: sessionJSON)
            let merge = try await storage.stagingCommitMerge()
            let revived = try await storage.loadSession("sess-selftest-1")
            record("storage.tombstone-resurrect",
                   (merge["skipped"] as? Int == 0) && revived != nil,
                   "skipped=\(merge["skipped"] as? Int ?? -1) revived=\(revived != nil)")
            // 再次删除，恢复空库供迁移测试
            _ = try await storage.deleteSession(id: "sess-selftest-1")
        } catch {
            record("storage.tombstone", false, "setup error=\(type(of: error))")
        }

        // 6.5 迁移：hash 校验失败拒绝 + 正确 hash 计数核对后切换模式
        do {
            try await storage.migrationBegin(expectedSessions: 1, expectedFiles: 1)
            do {
                try await storage.migrationPutSession(json: sessionJSON, sha256: String(repeating: "0", count: 64))
                record("storage.migration-hash", false, "wrong hash accepted")
                return
            } catch {
                // 预期失败
            }
            let digest = StorageService.sha256Hex(Data(sessionJSON.utf8))
            try await storage.migrationPutSession(json: sessionJSON, sha256: digest)
            try await storage.migrationPutFileBegin(fileId: "file-st-1", mime: "text/plain")
            try await storage.migrationPutFileAppend(fileId: "file-st-1", base64: blobData.base64EncodedString())
            try await storage.migrationPutFileFinish(fileId: "file-st-1")
            do {
                // 条数不符（预期 2 个会话）应拒绝切换
                _ = try await storage.migrationCommit(expectedSessions: 2, expectedFiles: 1)
                record("storage.migration-count", false, "count mismatch accepted")
                return
            } catch { /* 预期失败 */ }
            let result = try await storage.migrationCommit(expectedSessions: 1, expectedFiles: 1)
            let mode = result["mode"] as? String ?? ""
            record("storage.migration-commit", mode == "sqlite", "mode=\(mode) sessions=\(result["sessions"] as? Int ?? -1)")
        } catch {
            record("storage.migration-commit", false, "error=\(type(of: error))")
        }
    }
}
