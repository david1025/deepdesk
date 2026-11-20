import Foundation
import CommonCrypto
import SQLite3

/// SQLite3 系统模块未导出的绑定析构器
let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

/// 正式会话存储（T06）：SQLite + 内容寻址 blob 文件。
/// - 数据库：Application Support/<bundle>/Storage/chat.db（WAL）；原件：Attachments/<sha256>
/// - 全部写入在单个事务内；blob 先原子写入临时文件再引用；失败清理孤儿
/// - 删除会话写 tombstone，防止其他窗口把已删除会话用旧状态写回（B07/E08）
/// - 存储故障映射为结构化错误（full/readonly/busy/corrupt）回传网页（E08）
/// - 串行队列执行全部 SQLite 操作；async 封装供 Bridge 调用
/// - 每次变更递增 meta.revision 并回调 onChange → 各窗口 nativeStorageChanged 事件
/// - 可变状态（db/revision/opened）仅在串行队列上访问，故 @unchecked Sendable
final class StorageService: @unchecked Sendable {

    // MARK: - 错误

    enum StorageError: Error {
        case invalidParameter(String)
        case notFound
        case sessionDeleted
        case sqlite(code: Int32, message: String)

        var payload: [String: Any] {
            switch self {
            case .invalidParameter(let message):
                return ["code": "INVALID_REQUEST", "message": message]
            case .notFound:
                return ["code": "STORAGE_NOT_FOUND", "message": "记录不存在。"]
            case .sessionDeleted:
                return ["code": "STORAGE_SESSION_DELETED", "message": "该会话已被删除，请刷新列表。"]
            case .sqlite(let code, _):
                let kind: String
                let text: String
                switch code {
                case 13, SQLITE_FULL:
                    kind = "storage-full"
                    text = "磁盘空间不足，无法保存聊天数据。"
                case 8, SQLITE_READONLY:
                    kind = "storage-readonly"
                    text = "存储目录不可写，无法保存聊天数据。"
                case 5, SQLITE_BUSY:
                    kind = "storage-busy"
                    text = "存储正被其他操作占用，请稍后重试。"
                case 11, SQLITE_CORRUPT:
                    kind = "storage-corrupt"
                    text = "本地数据库损坏。为保护数据已停止写入，请从完整备份恢复。"
                default:
                    kind = "storage-error"
                    text = "本地存储操作失败（SQLite \(code)）。"
                }
                return ["code": kind, "message": text, "sqliteCode": Int(code)]
            }
        }
    }

    // MARK: - 路径

    static func defaultDatabaseURL() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent(bundleFolder(), isDirectory: true)
            .appendingPathComponent("Storage", isDirectory: true)
            .appendingPathComponent("chat.db")
    }

    static func defaultAttachmentsURL() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent(bundleFolder(), isDirectory: true)
            .appendingPathComponent("Attachments", isDirectory: true)
    }

    private static func bundleFolder() -> String {
        Bundle.main.bundleIdentifier ?? BundleDataMigration.bundleIdentifier
    }

    // MARK: - 状态

    private let queue = DispatchQueue(label: "com.deepseek.mac.storage")
    private var db: OpaquePointer?
    private let databaseURL: URL
    private let attachmentsURL: URL
    /// 存储变更广播（B07 多窗口一致性 / T11 事件源）
    var onChange: ((Int, String, String) -> Void)?
    private var revision: Int = 0
    private var opened = false

    init(databaseURL: URL = StorageService.defaultDatabaseURL(),
         attachmentsURL: URL = StorageService.defaultAttachmentsURL()) {
        self.databaseURL = databaseURL
        self.attachmentsURL = attachmentsURL
        queue.sync {
            do {
                try openDatabase()
                revision = Int(currentRevisionRaw())
                opened = true
            } catch {
                NSLog("Storage init failed: %@", String(describing: error))
            }
        }
    }

    deinit {
        if let db { sqlite3_close(db) }
    }

    @discardableResult
    private func run<T>(_ work: @escaping () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            queue.async { [weak self] in
                guard let self, self.opened else {
                    continuation.resume(throwing: StorageError.sqlite(code: -1, message: "storage unavailable"))
                    return
                }
                do {
                    continuation.resume(returning: try work())
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    // MARK: - SQLite 基础

    private func openDatabase() throws {
        try FileManager.default.createDirectory(at: databaseURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: attachmentsURL, withIntermediateDirectories: true)
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        var handle: OpaquePointer?
        guard sqlite3_open_v2(databaseURL.path, &handle, flags, nil) == SQLITE_OK, let handle else {
            let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "open failed"
            let code = handle.map { sqlite3_errcode($0) } ?? -2
            sqlite3_close(handle)
            throw StorageError.sqlite(code: code, message: message)
        }
        db = handle
        try exec("PRAGMA journal_mode=WAL")
        try exec("PRAGMA synchronous=NORMAL")
        try migrate()
    }

    private func exec(_ sql: String) throws {
        var errorPointer: UnsafeMutablePointer<CChar>?
        guard sqlite3_exec(db, sql, nil, nil, &errorPointer) == SQLITE_OK else {
            let code = sqlite3_errcode(db)
            let message = errorPointer.map { String(cString: $0) } ?? "exec failed"
            sqlite3_free(errorPointer)
            throw StorageError.sqlite(code: code, message: message)
        }
    }

    private final class Statement {
        let handle: OpaquePointer
        init(_ db: OpaquePointer?, _ sql: String) throws {
            var statement: OpaquePointer?
            guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
                throw StorageError.sqlite(
                    code: sqlite3_errcode(db),
                    message: String(cString: sqlite3_errmsg(db))
                )
            }
            self.handle = statement
        }
        deinit { sqlite3_finalize(handle) }
        func reset() { sqlite3_reset(handle); sqlite3_clear_bindings(handle) }
    }

    private func bind(_ statement: Statement, index: Int32, _ value: String) {
        sqlite3_bind_text(statement.handle, index, value, -1, SQLITE_TRANSIENT)
    }

    private func bind(_ statement: Statement, index: Int32, _ value: Int) {
        sqlite3_bind_int64(statement.handle, index, Int64(value))
    }

    private func bindNull(_ statement: Statement, index: Int32) {
        sqlite3_bind_null(statement.handle, index)
    }

    private func text(_ statement: Statement, column: Int32) -> String? {
        guard sqlite3_column_type(statement.handle, column) != SQLITE_NULL else { return nil }
        return String(cString: sqlite3_column_text(statement.handle, column))
    }

    private func int(_ statement: Statement, column: Int32) -> Int {
        Int(sqlite3_column_int64(statement.handle, column))
    }

    private func data(_ statement: Statement, column: Int32) -> Data? {
        guard sqlite3_column_type(statement.handle, column) != SQLITE_NULL else { return nil }
        let count = Int(sqlite3_column_bytes(statement.handle, column))
        guard count > 0, let bytes = sqlite3_column_blob(statement.handle, column) else { return Data() }
        return Data(bytes: bytes, count: count)
    }

    private func step(_ statement: Statement) throws {
        let result = sqlite3_step(statement.handle)
        guard result == SQLITE_DONE || result == SQLITE_ROW else {
            throw StorageError.sqlite(
                code: sqlite3_errcode(db),
                message: String(cString: sqlite3_errmsg(db))
            )
        }
    }

    /// 单步并返回第一列整数（COUNT 查询用）
    private func stepCount(_ statement: Statement) throws -> Int {
        let result = sqlite3_step(statement.handle)
        defer { statement.reset() }
        guard result == SQLITE_ROW else {
            if result == SQLITE_DONE { return 0 }
            throw StorageError.sqlite(code: sqlite3_errcode(db), message: String(cString: sqlite3_errmsg(db)))
        }
        return int(statement, column: 0)
    }

    private func migrate() throws {
        try exec("""
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
        """)
        try exec("""
        CREATE TABLE IF NOT EXISTS sessions (
          session_id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          current_message_id TEXT,
          content_json TEXT NOT NULL DEFAULT '{}'
        )
        """)
        try exec("""
        CREATE TABLE IF NOT EXISTS messages (
          session_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          role TEXT NOT NULL,
          parent_id TEXT,
          model TEXT,
          usage_json TEXT,
          completed_at INTEGER,
          content_json TEXT NOT NULL,
          PRIMARY KEY (session_id, message_id)
        )
        """)
        try exec("""
        CREATE TABLE IF NOT EXISTS session_files (
          session_id TEXT NOT NULL,
          file_id TEXT NOT NULL,
          PRIMARY KEY (session_id, file_id)
        )
        """)
        try exec("""
        CREATE INDEX IF NOT EXISTS session_files_file ON session_files (file_id)
        """)
        try exec("""
        CREATE TABLE IF NOT EXISTS attachments (
          file_id TEXT PRIMARY KEY,
          sha256 TEXT NOT NULL,
          size INTEGER NOT NULL,
          mime TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL
        )
        """)
        try exec("""
        CREATE INDEX IF NOT EXISTS attachments_sha ON attachments (sha256)
        """)
        try exec("""
        CREATE TABLE IF NOT EXISTS tombstones (
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          removed_at INTEGER NOT NULL,
          PRIMARY KEY (entity_type, entity_id)
        )
        """)
        try exec("""
        CREATE TABLE IF NOT EXISTS sessions_staging (
          session_id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          current_message_id TEXT,
          content_json TEXT NOT NULL DEFAULT '{}'
        )
        """)
        try exec("""
        CREATE TABLE IF NOT EXISTS messages_staging (
          session_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          role TEXT NOT NULL,
          parent_id TEXT,
          model TEXT,
          usage_json TEXT,
          completed_at INTEGER,
          content_json TEXT NOT NULL,
          PRIMARY KEY (session_id, message_id)
        )
        """)
        try exec("""
        CREATE TABLE IF NOT EXISTS session_files_staging (
          session_id TEXT NOT NULL,
          file_id TEXT NOT NULL,
          PRIMARY KEY (session_id, file_id)
        )
        """)
        try exec("""
        CREATE TABLE IF NOT EXISTS files_staging (
          file_id TEXT PRIMARY KEY,
          sha256 TEXT NOT NULL,
          size INTEGER NOT NULL,
          mime TEXT NOT NULL DEFAULT '',
          blob BLOB NOT NULL
        )
        """)
        try exec("""
        CREATE TABLE IF NOT EXISTS blob_staging (
          file_id TEXT PRIMARY KEY,
          mime TEXT NOT NULL DEFAULT '',
          data BLOB,
          updated_at INTEGER NOT NULL
        )
        """)
        try exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')")
        try exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('storage_mode', 'idb')")
        try exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('revision', '0')")
        // 兼容早期开发库：messages_staging 曾缺 model/usage_json/completed_at 列
        for (table, column, ddl) in [
            ("messages_staging", "model", "ALTER TABLE messages_staging ADD COLUMN model TEXT"),
            ("messages_staging", "usage_json", "ALTER TABLE messages_staging ADD COLUMN usage_json TEXT"),
            ("messages_staging", "completed_at", "ALTER TABLE messages_staging ADD COLUMN completed_at INTEGER"),
        ] {
            if try !hasColumn(table: table, column: column) {
                try exec(ddl)
            }
        }
    }

    private func hasColumn(table: String, column: String) throws -> Bool {
        let statement = try Statement(db, "PRAGMA table_info(\(table))")
        while sqlite3_step(statement.handle) == SQLITE_ROW {
            if text(statement, column: 1) == column {
                return true
            }
        }
        return false
    }

    private func currentRevisionRaw() -> Int64 {
        do {
            let statement = try Statement(db, "SELECT CAST(value AS INTEGER) FROM meta WHERE key='revision'")
            if sqlite3_step(statement.handle) == SQLITE_ROW {
                return sqlite3_column_int64(statement.handle, 0)
            }
        } catch {
            NSLog("storage revision read failed: %@", String(describing: error))
        }
        return 0
    }

    @discardableResult
    private func transaction<T>(_ body: () throws -> T) throws -> T {
        try exec("BEGIN IMMEDIATE")
        do {
            let result = try body()
            revision += 1
            let statement = try Statement(db, "UPDATE meta SET value=? WHERE key='revision'")
            bind(statement, index: 1, String(revision))
            try step(statement)
            try exec("COMMIT")
            return result
        } catch {
            sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
            throw error
        }
    }

    private func notify(entityType: String, entityId: String) {
        onChange?(revision, entityType, entityId)
    }

    private func metaValue(_ key: String) throws -> String? {
        let statement = try Statement(db, "SELECT value FROM meta WHERE key=?")
        bind(statement, index: 1, key)
        if sqlite3_step(statement.handle) == SQLITE_ROW {
            return text(statement, column: 0)
        }
        return nil
    }

    // MARK: - 会话 JSON 解析 / 重建

    private struct SessionRecord {
        var id: String
        var title: String
        var createdAt: Int
        var updatedAt: Int
        var rootMessageId: String?
        var messages: [[String: Any]]
        var fileIds: [String]
    }

    private struct SessionParseError: Error {}

    private func parseSessionJSON(_ jsonString: String) throws -> SessionRecord {
        guard let data = jsonString.data(using: .utf8),
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = object["id"] as? String, !id.isEmpty,
              id.count <= 128,
              let messages = object["messages"] as? [[String: Any]] else {
            throw SessionParseError()
        }
        let createdAt = (object["createdAt"] as? NSNumber)?.intValue ?? 0
        let updatedAt = (object["updatedAt"] as? NSNumber)?.intValue ?? createdAt
        let fileIds = messages.flatMap { message -> [String] in
            guard (message["role"] as? String) == "user",
                  let files = message["files"] as? [[String: Any]] else { return [] }
            return files.compactMap { $0["id"] as? String }
        }
        return SessionRecord(
            id: id,
            title: (object["title"] as? String) ?? "",
            createdAt: createdAt,
            updatedAt: updatedAt,
            rootMessageId: object["rootMessageId"] as? String,
            messages: messages,
            fileIds: fileIds
        )
    }

    private func buildSessionJSON(row: (id: String, title: String, createdAt: Int, updatedAt: Int, root: String?), messages: [[String: Any]]) throws -> String {
        var object: [String: Any] = [
            "id": row.id,
            "title": row.title,
            "createdAt": row.createdAt,
            "updatedAt": row.updatedAt,
            "messages": messages,
        ]
        if let root = row.root {
            object["rootMessageId"] = root
        }
        let data = try JSONSerialization.data(withJSONObject: object)
        guard let string = String(data: data, encoding: .utf8) else {
            throw StorageError.sqlite(code: -3, message: "session JSON rebuild failed")
        }
        return string
    }

    /// 把会话写进目标表组（sessions/messages/session_files 或 *_staging）
    private func insertSessionRows(record: SessionRecord, table: String) throws {
        let insertSession = try Statement(db, """
        INSERT OR REPLACE INTO \(table) (session_id, title, created_at, updated_at, current_message_id, content_json)
        VALUES (?, ?, ?, ?, ?, ?)
        """)
        let summaryData = try JSONSerialization.data(withJSONObject: [
            "id": record.id, "title": record.title,
            "createdAt": record.createdAt, "updatedAt": record.updatedAt,
        ])
        bind(insertSession, index: 1, record.id)
        bind(insertSession, index: 2, record.title)
        bind(insertSession, index: 3, record.createdAt)
        bind(insertSession, index: 4, record.updatedAt)
        if let root = record.rootMessageId {
            bind(insertSession, index: 5, root)
        } else {
            bindNull(insertSession, index: 5)
        }
        bind(insertSession, index: 6, String(data: summaryData, encoding: .utf8) ?? "{}")
        try step(insertSession)

        let insertMessage = try Statement(db, """
        INSERT OR REPLACE INTO \(table == "sessions" ? "messages" : "messages_staging")
        (session_id, message_id, seq, role, parent_id, model, usage_json, completed_at, content_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """)
        let insertStagingMessage = try Statement(db, """
        INSERT OR REPLACE INTO messages_staging (session_id, message_id, seq, role, parent_id, content_json)
        VALUES (?, ?, ?, ?, ?, ?)
        """)
        for (index, message) in record.messages.enumerated() {
            let messageId = (message["id"] as? String) ?? "seq-\(index)"
            let role = (message["role"] as? String) ?? "assistant"
            let messageData = try JSONSerialization.data(withJSONObject: message)
            let messageJSON = String(data: messageData, encoding: .utf8) ?? "{}"
            if table == "sessions" {
                bind(insertMessage, index: 1, record.id)
                bind(insertMessage, index: 2, messageId)
                bind(insertMessage, index: 3, index)
                bind(insertMessage, index: 4, role)
                if let parentId = message["parentId"] as? String {
                    bind(insertMessage, index: 5, parentId)
                } else { bindNull(insertMessage, index: 5) }
                if let model = message["model"] as? String {
                    bind(insertMessage, index: 6, model)
                } else { bindNull(insertMessage, index: 6) }
                if let usage = message["usage"] {
                    let usageData = try JSONSerialization.data(withJSONObject: usage)
                    bind(insertMessage, index: 7, String(data: usageData, encoding: .utf8) ?? "")
                } else { bindNull(insertMessage, index: 7) }
                if let completedAt = (message["completedAt"] as? NSNumber)?.intValue {
                    bind(insertMessage, index: 8, completedAt)
                } else { bindNull(insertMessage, index: 8) }
                bind(insertMessage, index: 9, messageJSON)
                try step(insertMessage)
                insertMessage.reset()
            } else {
                bind(insertStagingMessage, index: 1, record.id)
                bind(insertStagingMessage, index: 2, messageId)
                bind(insertStagingMessage, index: 3, index)
                bind(insertStagingMessage, index: 4, role)
                if let parentId = message["parentId"] as? String {
                    bind(insertStagingMessage, index: 5, parentId)
                } else { bindNull(insertStagingMessage, index: 5) }
                bind(insertStagingMessage, index: 6, messageJSON)
                try step(insertStagingMessage)
                insertStagingMessage.reset()
            }
        }

        let insertFileRef = try Statement(db, """
        INSERT OR IGNORE INTO \(table == "sessions" ? "session_files" : "session_files_staging") (session_id, file_id) VALUES (?, ?)
        """)
        for fileId in Set(record.fileIds) {
            bind(insertFileRef, index: 1, record.id)
            bind(insertFileRef, index: 2, fileId)
            try step(insertFileRef)
            insertFileRef.reset()
        }
    }

    // MARK: - 模式与统计

    func getMode() async throws -> String {
        try await run { [self] in
            (try metaValue("storage_mode")) ?? "idb"
        }
    }

    func stats() async throws -> [String: Any] {
        try await run { [self] in
            var result: [String: Any] = [
                "mode": (try metaValue("storage_mode")) ?? "idb",
                "revision": revision,
                "dbPath": databaseURL.path,
            ]
            var statement = try Statement(db, "SELECT COUNT(*) FROM sessions")
            if sqlite3_step(statement.handle) == SQLITE_ROW { result["sessions"] = int(statement, column: 0) }
            statement = try Statement(db, "SELECT COUNT(*), COALESCE(SUM(size),0) FROM attachments")
            if sqlite3_step(statement.handle) == SQLITE_ROW {
                result["attachments"] = int(statement, column: 0)
                result["attachmentBytes"] = int(statement, column: 1)
            }
            return result
        }
    }

    // MARK: - 会话 CRUD

    func listSummaries() async throws -> [[String: Any]] {
        try await run { [self] in
            let query = try Statement(db, """
            SELECT session_id, title, created_at, updated_at FROM sessions
            WHERE session_id NOT IN (SELECT entity_id FROM tombstones WHERE entity_type='session')
            ORDER BY updated_at DESC
            """)
            var rows: [[String: Any]] = []
            while sqlite3_step(query.handle) == SQLITE_ROW {
                rows.append([
                    "id": text(query, column: 0) ?? "",
                    "title": text(query, column: 1) ?? "",
                    "createdAt": int(query, column: 2),
                    "updatedAt": int(query, column: 3),
                    "revision": revision,
                ])
            }
            return rows
        }
    }

    func loadSession(_ id: String) async throws -> [String: Any]? {
        try await run { [self] in
            let sessionStatement = try Statement(db, """
            SELECT session_id, title, created_at, updated_at, current_message_id
            FROM sessions WHERE session_id=?
              AND session_id NOT IN (SELECT entity_id FROM tombstones WHERE entity_type='session')
            """)
            bind(sessionStatement, index: 1, id)
            guard sqlite3_step(sessionStatement.handle) == SQLITE_ROW else { return nil }
            let row = (
                text(sessionStatement, column: 0) ?? "",
                text(sessionStatement, column: 1) ?? "",
                int(sessionStatement, column: 2),
                int(sessionStatement, column: 3),
                text(sessionStatement, column: 4)
            )
            let messageStatement = try Statement(db, "SELECT content_json FROM messages WHERE session_id=? ORDER BY seq ASC")
            bind(messageStatement, index: 1, id)
            var messages: [[String: Any]] = []
            while sqlite3_step(messageStatement.handle) == SQLITE_ROW {
                guard let json = text(messageStatement, column: 0),
                      let data = json.data(using: .utf8),
                      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    continue
                }
                messages.append(object)
            }
            return [
                "session": try buildSessionJSON(row: row, messages: messages),
                "revision": revision,
            ]
        }
    }

    /// 保存会话：tombstone 拦截 + 新附件落盘 + 全量重写行，单个事务（B07/E08）
    func saveSession(json: String, fileIds: [String]) async throws -> [String: Any] {
        let result: [String: Any] = try await run { [self] in
            let record = try parseSessionJSON(json)
            let payload: [String: Any] = try transaction {
                try assertNotDeleted(record.id)
                // blob_staging 中已上传完成的新附件：落盘 + 登记
                // blobPutFinish 已把字节写入 Attachments/<sha256> 并在 meta 留 hint；
                // saveSession 只负责登记 attachments 行，避免数据库内重复搬运大对象。
                let stagedStatement = try Statement(db, "SELECT data, mime FROM blob_staging WHERE file_id=?")
                let existingAttachment = try Statement(db, "SELECT COUNT(*) FROM attachments WHERE file_id=?")
                let insertAttachment = try Statement(db, """
                INSERT OR REPLACE INTO attachments (file_id, sha256, size, mime, created_at)
                VALUES (?, ?, ?, ?, ?)
                """)
                let hintStatement = try Statement(db, "SELECT value FROM meta WHERE key=?")
                let removeStaged = try Statement(db, "DELETE FROM blob_staging WHERE file_id=?")
                let removeHint = try Statement(db, "DELETE FROM meta WHERE key=?")

                for fileId in fileIds {
                    bind(existingAttachment, index: 1, fileId)
                    if try stepCount(existingAttachment) > 0 { continue }
                    var digest: String?
                    var size = 0
                    var mime = ""
                    // 优先读 blob_staging 内的数据（兼容 hint 丢失的场景），否则读 hint
                    bind(stagedStatement, index: 1, fileId)
                    if sqlite3_step(stagedStatement.handle) == SQLITE_ROW,
                       let chunkData = data(stagedStatement, column: 0), !chunkData.isEmpty {
                        mime = text(stagedStatement, column: 1) ?? ""
                        digest = Self.sha256Hex(chunkData)
                        size = chunkData.count
                        try writeBlobFile(digest: digest!, data: chunkData)
                    }
                    stagedStatement.reset()
                    if digest == nil {
                        bind(hintStatement, index: 1, "blob-hint:\(fileId)")
                        if sqlite3_step(hintStatement.handle) == SQLITE_ROW,
                           let hint = text(hintStatement, column: 0) {
                            let parts = hint.split(separator: "|", maxSplits: 2)
                            if parts.count == 3, let hintSize = Int(parts[1]) {
                                digest = String(parts[0])
                                size = hintSize
                                mime = String(parts[2])
                            }
                        }
                        hintStatement.reset()
                    }
                    guard let resolvedDigest = digest, size >= 0 else {
                        throw StorageError.invalidParameter("附件 \(fileId) 的数据尚未上传")
                    }
                    bind(insertAttachment, index: 1, fileId)
                    bind(insertAttachment, index: 2, resolvedDigest)
                    bind(insertAttachment, index: 3, size)
                    bind(insertAttachment, index: 4, mime)
                    bind(insertAttachment, index: 5, Int(Date().timeIntervalSince1970 * 1000))
                    try step(insertAttachment)
                    insertAttachment.reset()
                    bind(removeStaged, index: 1, fileId)
                    try step(removeStaged)
                    removeStaged.reset()
                    bind(removeHint, index: 1, "blob-hint:\(fileId)")
                    try step(removeHint)
                    removeHint.reset()
                }

                // 全量重写该会话的数据行（消息树按 seq 顺序保存，可回放）
                let deleteMessages = try Statement(db, "DELETE FROM messages WHERE session_id=?")
                bind(deleteMessages, index: 1, record.id)
                try step(deleteMessages)
                let deleteRefs = try Statement(db, "DELETE FROM session_files WHERE session_id=?")
                bind(deleteRefs, index: 1, record.id)
                try step(deleteRefs)
                try insertSessionRows(record: record, table: "sessions")
                return ["revision": revision]
            }
            return payload
        }
        if let id = (try? parseSessionJSON(json))?.id {
            notify(entityType: "session", entityId: id)
        }
        return result
    }

    private func assertNotDeleted(_ id: String) throws {
        let tombstone = try Statement(db, "SELECT 1 FROM tombstones WHERE entity_type='session' AND entity_id=?")
        bind(tombstone, index: 1, id)
        if sqlite3_step(tombstone.handle) == SQLITE_ROW {
            throw StorageError.sessionDeleted
        }
    }

    private func writeBlobFile(digest: String, data: Data) throws {
        let target = attachmentsURL.appendingPathComponent(digest)
        if FileManager.default.fileExists(atPath: target.path) { return }
        let temp = attachmentsURL.appendingPathComponent(".tmp-\(UUID().uuidString)")
        try data.write(to: temp, options: .atomic)
        try FileManager.default.moveItem(at: temp, to: target)
    }

    func renameSession(id: String, title: String) async throws -> [String: Any] {
        let result: [String: Any] = try await run { [self] in
            try transaction {
                try assertNotDeleted(id)
                let statement = try Statement(db, "UPDATE sessions SET title=? WHERE session_id=?")
                bind(statement, index: 1, title)
                bind(statement, index: 2, id)
                try step(statement)
                return ["revision": revision]
            }
        }
        notify(entityType: "session", entityId: id)
        return result
    }

    /// 删除会话：tombstone + 删行；不再被引用的原件在提交后从磁盘清理
    func deleteSession(id: String) async throws -> [String: Any] {
        let orphanShas: [String] = try await run { [self] in
            try transaction {
                let referenced = try Statement(db, "SELECT DISTINCT file_id FROM session_files WHERE session_id=?")
                bind(referenced, index: 1, id)
                var candidates: [String] = []
                while sqlite3_step(referenced.handle) == SQLITE_ROW {
                    if let fileId = text(referenced, column: 0) { candidates.append(fileId) }
                }
                let tombstone = try Statement(db, "INSERT OR REPLACE INTO tombstones (entity_type, entity_id, removed_at) VALUES ('session', ?, ?)")
                bind(tombstone, index: 1, id)
                bind(tombstone, index: 2, Int(Date().timeIntervalSince1970 * 1000))
                try step(tombstone)
                let deleteSessionStatement = try Statement(db, "DELETE FROM sessions WHERE session_id=?")
                bind(deleteSessionStatement, index: 1, id)
                try step(deleteSessionStatement)
                let deleteMessages = try Statement(db, "DELETE FROM messages WHERE session_id=?")
                bind(deleteMessages, index: 1, id)
                try step(deleteMessages)
                let deleteRefs = try Statement(db, "DELETE FROM session_files WHERE session_id=?")
                bind(deleteRefs, index: 1, id)
                try step(deleteRefs)
                var orphans: [String] = []
                for fileId in candidates {
                    let otherReference = try Statement(db, "SELECT COUNT(*) FROM session_files WHERE file_id=?")
                    bind(otherReference, index: 1, fileId)
                    if try stepCount(otherReference) > 0 { continue }
                    let shaStatement = try Statement(db, "SELECT sha256 FROM attachments WHERE file_id=?")
                    bind(shaStatement, index: 1, fileId)
                    var sha256: String?
                    if sqlite3_step(shaStatement.handle) == SQLITE_ROW {
                        sha256 = text(shaStatement, column: 0)
                    }
                    shaStatement.reset()
                    let deleteAttachment = try Statement(db, "DELETE FROM attachments WHERE file_id=?")
                    bind(deleteAttachment, index: 1, fileId)
                    try step(deleteAttachment)
                    if let sha256 {
                        let sharedSha = try Statement(db, "SELECT COUNT(*) FROM attachments WHERE sha256=?")
                        bind(sharedSha, index: 1, sha256)
                        if try stepCount(sharedSha) == 0 {
                            orphans.append(sha256)
                        }
                    }
                }
                return orphans
            }
        }
        for sha256 in orphanShas {
            try? FileManager.default.removeItem(at: attachmentsURL.appendingPathComponent(sha256))
        }
        notify(entityType: "session", entityId: id)
        return ["revision": revision]
    }

    func listSessionIds() async throws -> [String] {
        try await run { [self] in
            let statement = try Statement(db, "SELECT session_id FROM sessions")
            var ids: [String] = []
            while sqlite3_step(statement.handle) == SQLITE_ROW {
                if let id = text(statement, column: 0) { ids.append(id) }
            }
            return ids
        }
    }

    func listFileIds() async throws -> [String] {
        try await run { [self] in
            let statement = try Statement(db, "SELECT file_id FROM attachments")
            var ids: [String] = []
            while sqlite3_step(statement.handle) == SQLITE_ROW {
                if let id = text(statement, column: 0) { ids.append(id) }
            }
            return ids
        }
    }

    func loadAllUsage() async throws -> [[String: Any]] {
        try await run { [self] in
            let statement = try Statement(db, """
            SELECT model, usage_json, completed_at FROM messages
            WHERE usage_json IS NOT NULL ORDER BY COALESCE(completed_at, 0) ASC
            """)
            var rows: [[String: Any]] = []
            while sqlite3_step(statement.handle) == SQLITE_ROW {
                var row: [String: Any] = ["completedAt": int(statement, column: 2)]
                if let model = text(statement, column: 0) { row["model"] = model }
                if let usageJson = text(statement, column: 1),
                   let usageData = usageJson.data(using: .utf8),
                   let usage = try? JSONSerialization.jsonObject(with: usageData) {
                    row["usage"] = usage
                }
                rows.append(row)
            }
            return rows
        }
    }

    // MARK: - 附件读取（分块）

    func loadFileMeta(fileId: String) async throws -> [String: Any] {
        try await run { [self] in
            let statement = try Statement(db, "SELECT mime, size, sha256 FROM attachments WHERE file_id=?")
            bind(statement, index: 1, fileId)
            guard sqlite3_step(statement.handle) == SQLITE_ROW else {
                throw StorageError.notFound
            }
            return [
                "mime": text(statement, column: 0) ?? "",
                "size": int(statement, column: 1),
                "sha256": text(statement, column: 2) ?? "",
            ] as [String: Any]
        }
    }

    func readBlob(fileId: String, offset: Int, length: Int) async throws -> [String: Any] {
        try await run { [self] in
            guard length > 0, length <= 4 * 1024 * 1024, offset >= 0 else {
                throw StorageError.invalidParameter("分块参数无效")
            }
            let statement = try Statement(db, "SELECT sha256 FROM attachments WHERE file_id=?")
            bind(statement, index: 1, fileId)
            guard sqlite3_step(statement.handle) == SQLITE_ROW, let sha256 = text(statement, column: 0) else {
                throw StorageError.notFound
            }
            let fileHandle = try FileHandle(forReadingFrom: attachmentsURL.appendingPathComponent(sha256))
            defer { try? fileHandle.close() }
            try fileHandle.seek(toOffset: UInt64(offset))
            let chunk = fileHandle.readData(ofLength: length)
            return ["base64": chunk.base64EncodedString()] as [String: Any]
        }
    }

    // MARK: - blob 上传暂存（saveSession 前先推文件字节）

    func blobPutBegin(fileId: String, mime: String) async throws {
        try await run { [self] in
            try transaction {
                let statement = try Statement(db, "INSERT OR REPLACE INTO blob_staging (file_id, mime, data, updated_at) VALUES (?, ?, NULL, ?)")
                bind(statement, index: 1, fileId)
                bind(statement, index: 2, mime)
                bind(statement, index: 3, Int(Date().timeIntervalSince1970 * 1000))
                try step(statement)
                return 0
            }
        }
    }

    func blobPutAppend(fileId: String, base64: String) async throws {
        guard let chunk = Data(base64Encoded: base64), !chunk.isEmpty else {
            throw StorageError.invalidParameter("分块编码无效")
        }
        try await run { [self] in
            try transaction {
                // SQLite 无原生 blob append；读取现有数据在内存拼接（附件 ≤ 128MB）
                let read = try Statement(db, "SELECT data FROM blob_staging WHERE file_id=?")
                bind(read, index: 1, fileId)
                var existing = Data()
                if sqlite3_step(read.handle) == SQLITE_ROW {
                    existing = data(read, column: 0) ?? Data()
                    if existing.count == 0 { existing = Data() }
                }
                read.reset()
                existing.append(chunk)
                let update = try Statement(db, "UPDATE blob_staging SET data=?, updated_at=? WHERE file_id=?")
                sqlite3_bind_blob(update.handle, 1, (existing as NSData).bytes, Int32(existing.count), SQLITE_TRANSIENT)
                bind(update, index: 2, Int(Date().timeIntervalSince1970 * 1000))
                bind(update, index: 3, fileId)
                try step(update)
                return 0
            }
        }
    }

    func blobPutFinish(fileId: String) async throws -> [String: Any] {
        try await run { [self] in
            try transaction {
                let statement = try Statement(db, "SELECT data, mime FROM blob_staging WHERE file_id=?")
                bind(statement, index: 1, fileId)
                guard sqlite3_step(statement.handle) == SQLITE_ROW,
                      let blobData = data(statement, column: 0), !blobData.isEmpty else {
                    throw StorageError.invalidParameter("上传会话不存在或为空")
                }
                let mime = text(statement, column: 1) ?? ""
                let digest = Self.sha256Hex(blobData)
                // 先落盘（事务内写文件；事务失败时孤儿文件由启动 GC 清理）
                try writeBlobFile(digest: digest, data: blobData)
                // 释放数据库内数据，保留 hint 供 saveSession 引用
                let hint = try Statement(db, "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
                bind(hint, index: 1, "blob-hint:\(fileId)")
                bind(hint, index: 2, "\(digest)|\(blobData.count)|\(mime)")
                try step(hint)
                let clear = try Statement(db, "UPDATE blob_staging SET data=NULL WHERE file_id=?")
                bind(clear, index: 1, fileId)
                try step(clear)
                return ["sha256": digest, "size": blobData.count, "revision": revision]
            }
        }
    }

    func blobPutCancel(fileId: String) async throws {
        try await run { [self] in
            try transaction {
                let statement = try Statement(db, "DELETE FROM blob_staging WHERE file_id=?")
                bind(statement, index: 1, fileId)
                try step(statement)
                let hint = try Statement(db, "DELETE FROM meta WHERE key=?")
                bind(hint, index: 1, "blob-hint:\(fileId)")
                try step(hint)
                return 0
            }
        }
    }

    /// 启动清理：过期上传暂存 + 无引用的孤儿 blob 文件
    func cleanupOrphans() async throws -> Int {
        try await run { [self] in
            let cutoff = Int(Date().timeIntervalSince1970 * 1000) - 24 * 3600 * 1000
            var removed = 0
            try transaction {
                let statement = try Statement(db, "DELETE FROM blob_staging WHERE updated_at < ?")
                bind(statement, index: 1, cutoff)
                try step(statement)
                return 0
            }
            // 孤儿文件：磁盘上有、数据库没有任何 attachments 行引用
            let known = try Statement(db, "SELECT DISTINCT sha256 FROM attachments")
            var knownShas = Set<String>()
            while sqlite3_step(known.handle) == SQLITE_ROW {
                if let sha = text(known, column: 0) { knownShas.insert(sha) }
            }
            let files = (try? FileManager.default.contentsOfDirectory(atPath: attachmentsURL.path)) ?? []
            for name in files where !name.hasPrefix(".tmp-") && !knownShas.contains(name) {
                try? FileManager.default.removeItem(at: attachmentsURL.appendingPathComponent(name))
                removed += 1
            }
            return removed
        }
    }

    // MARK: - 导入暂存（v3/v4 导入管线，语义与 IndexedDB staging 一致）

    func stagingClear() async throws {
        try await run { [self] in
            try transaction {
                try exec("DELETE FROM sessions_staging")
                try exec("DELETE FROM messages_staging")
                try exec("DELETE FROM session_files_staging")
                try exec("DELETE FROM files_staging")
                return 0
            }
        }
    }

    func stagingAddSession(json: String) async throws {
        try await run { [self] in
            let record = try parseSessionJSON(json)
            try transaction {
                let deleteOld = try Statement(db, "DELETE FROM sessions_staging WHERE session_id=?")
                bind(deleteOld, index: 1, record.id)
                try step(deleteOld)
                let deleteMessages = try Statement(db, "DELETE FROM messages_staging WHERE session_id=?")
                bind(deleteMessages, index: 1, record.id)
                try step(deleteMessages)
                let deleteRefs = try Statement(db, "DELETE FROM session_files_staging WHERE session_id=?")
                bind(deleteRefs, index: 1, record.id)
                try step(deleteRefs)
                try insertSessionRows(record: record, table: "sessions_staging")
                return 0
            }
        }
    }

    func stagingPutFileBegin(fileId: String, mime: String) async throws {
        try await run { [self] in
            try transaction {
                let statement = try Statement(db, "INSERT OR REPLACE INTO files_staging (file_id, sha256, size, mime, blob) VALUES (?, '', 0, ?, zeroblob(0))")
                bind(statement, index: 1, fileId)
                bind(statement, index: 2, mime)
                try step(statement)
                return 0
            }
        }
    }

    func stagingPutFileAppend(fileId: String, base64: String) async throws {
        guard let chunk = Data(base64Encoded: base64), !chunk.isEmpty else {
            throw StorageError.invalidParameter("分块编码无效")
        }
        try await run { [self] in
            try transaction {
                let read = try Statement(db, "SELECT blob FROM files_staging WHERE file_id=?")
                bind(read, index: 1, fileId)
                guard sqlite3_step(read.handle) == SQLITE_ROW else {
                    read.reset()
                    throw StorageError.invalidParameter("文件上传会话不存在")
                }
                var existing = data(read, column: 0) ?? Data()
                read.reset()
                if existing.isEmpty { existing = Data() }
                existing.append(chunk)
                let update = try Statement(db, "UPDATE files_staging SET blob=?, size=? WHERE file_id=?")
                sqlite3_bind_blob(update.handle, 1, (existing as NSData).bytes, Int32(existing.count), SQLITE_TRANSIENT)
                bind(update, index: 2, existing.count)
                bind(update, index: 3, fileId)
                try step(update)
                return 0
            }
        }
    }

    func stagingPutFileFinish(fileId: String) async throws {
        try await run { [self] in
            try transaction {
                let statement = try Statement(db, "SELECT blob FROM files_staging WHERE file_id=?")
                bind(statement, index: 1, fileId)
                guard sqlite3_step(statement.handle) == SQLITE_ROW,
                      let blobData = data(statement, column: 0), !blobData.isEmpty else {
                    throw StorageError.invalidParameter("上传会话不存在或为空")
                }
                let update = try Statement(db, "UPDATE files_staging SET sha256=? WHERE file_id=?")
                bind(update, index: 1, Self.sha256Hex(blobData))
                bind(update, index: 2, fileId)
                try step(update)
                return 0
            }
        }
    }

    /// 回填暂存会话中附件的 MIME（与上游 updateStagingFileTypes 行为一致）
    func stagingUpdateFileTypes(_ types: [String: String]) async throws {
        try await run { [self] in
            try transaction {
                let statement = try Statement(db, "SELECT message_id, content_json FROM messages_staging WHERE role='user'")
                var updates: [(String, String)] = []
                while sqlite3_step(statement.handle) == SQLITE_ROW {
                    guard let messageId = text(statement, column: 0),
                          let json = text(statement, column: 1),
                          let messageData = json.data(using: .utf8),
                          var message = try? JSONSerialization.jsonObject(with: messageData) as? [String: Any],
                          var files = message["files"] as? [[String: Any]] else { continue }
                    var changed = false
                    for index in files.indices {
                        if let fileId = files[index]["id"] as? String {
                            let type = types[fileId] ?? ""
                            if (files[index]["mimeType"] as? String) != type {
                                files[index]["mimeType"] = type
                                changed = true
                            }
                        }
                    }
                    guard changed else { continue }
                    message["files"] = files
                    if let newData = try? JSONSerialization.data(withJSONObject: message),
                       let newJSON = String(data: newData, encoding: .utf8) {
                        updates.append((messageId, newJSON))
                    }
                }
                for (messageId, newJSON) in updates {
                    let update = try Statement(db, "UPDATE messages_staging SET content_json=? WHERE message_id=?")
                    bind(update, index: 1, newJSON)
                    bind(update, index: 2, messageId)
                    try step(update)
                }
                return 0
            }
        }
    }

    /// 用暂存替换正式数据（覆盖导入）。返回本次提交的摘要列表。
    func stagingCommitReplace() async throws -> [[String: Any]] {
        try await run { [self] in
            var orphanShas: [String] = []
            let summaries: [[String: Any]] = try transaction {
                // 先把 files_staging 的 blob 落盘（事务失败时孤儿文件由启动 GC 清理）
                let fileStatement = try Statement(db, "SELECT file_id, sha256, size, mime, blob FROM files_staging")
                var stagedFiles: [(String, String, Int, String, Data)] = []
                while sqlite3_step(fileStatement.handle) == SQLITE_ROW {
                    guard let fileId = text(fileStatement, column: 0),
                          let sha256 = text(fileStatement, column: 1),
                          let blobData = data(fileStatement, column: 4), !blobData.isEmpty else { continue }
                    stagedFiles.append((fileId, sha256, int(fileStatement, column: 2), text(fileStatement, column: 3) ?? "", blobData))
                }
                for (fileId, sha256, size, mime, blobData) in stagedFiles {
                    try writeBlobFile(digest: sha256, data: blobData)
                    let insert = try Statement(db, "INSERT OR REPLACE INTO attachments (file_id, sha256, size, mime, created_at) VALUES (?, ?, ?, ?, ?)")
                    bind(insert, index: 1, fileId)
                    bind(insert, index: 2, sha256)
                    bind(insert, index: 3, size)
                    bind(insert, index: 4, mime)
                    bind(insert, index: 5, Int(Date().timeIntervalSince1970 * 1000))
                    try step(insert)
                }

                // 收集将被替换掉的原件（提交后按引用清理文件）
                let oldSha = try Statement(db, "SELECT DISTINCT sha256 FROM attachments")
                while sqlite3_step(oldSha.handle) == SQLITE_ROW {
                    if let sha = text(oldSha, column: 0) { orphanShas.append(sha) }
                }

                try exec("DELETE FROM sessions")
                try exec("DELETE FROM messages")
                try exec("DELETE FROM session_files")
                try exec("DELETE FROM attachments")
                try exec("DELETE FROM tombstones WHERE entity_type='session'")
                try exec("""
                INSERT INTO sessions (session_id, title, created_at, updated_at, current_message_id, content_json)
                SELECT session_id, title, created_at, updated_at, current_message_id, content_json FROM sessions_staging
                """)
                try exec("""
                INSERT INTO messages (session_id, message_id, seq, role, parent_id, content_json)
                SELECT session_id, message_id, seq, role, parent_id, content_json FROM messages_staging
                """)
                try exec("""
                INSERT INTO session_files (session_id, file_id)
                SELECT session_id, file_id FROM session_files_staging
                """)
                try exec("DELETE FROM sessions_staging")
                try exec("DELETE FROM messages_staging")
                try exec("DELETE FROM session_files_staging")
                try exec("DELETE FROM files_staging")

                let list = try Statement(db, "SELECT session_id, title, created_at, updated_at FROM sessions ORDER BY updated_at DESC")
                var rows: [[String: Any]] = []
                while sqlite3_step(list.handle) == SQLITE_ROW {
                    rows.append([
                        "id": text(list, column: 0) ?? "",
                        "title": text(list, column: 1) ?? "",
                        "createdAt": int(list, column: 2),
                        "updatedAt": int(list, column: 3),
                    ])
                }
                return rows
            }
            // 提交后清理不再被引用的原件文件（已在串行队列内，直接查询）
            for sha in orphanShas {
                let referenced = try Statement(db, "SELECT COUNT(*) FROM attachments WHERE sha256=?")
                bind(referenced, index: 1, sha)
                if try stepCount(referenced) == 0 {
                    try? FileManager.default.removeItem(at: attachmentsURL.appendingPathComponent(sha))
                }
            }
            notify(entityType: "sessions", entityId: "*")
            return summaries
        }
    }

    /// 合并暂存：已存在同 id 会话跳过（不覆盖），原件只在被引用时移入。返回新增摘要与跳过数。
    func stagingCommitMerge() async throws -> [String: Any] {
        try await run { [self] in
            let result: [String: Any] = try transaction {
                var skipped = 0
                var summaries: [[String: Any]] = []
                var usedFileIds = Set<String>()

                let sessionStatement = try Statement(db, "SELECT session_id FROM sessions_staging")
                var stagingIds: [String] = []
                while sqlite3_step(sessionStatement.handle) == SQLITE_ROW {
                    if let id = text(sessionStatement, column: 0) { stagingIds.append(id) }
                }
                let existing = try Statement(db, "SELECT 1 FROM sessions WHERE session_id=?")
                let moveSession = try Statement(db, """
                INSERT INTO sessions (session_id, title, created_at, updated_at, current_message_id, content_json)
                SELECT session_id, title, created_at, updated_at, current_message_id, content_json FROM sessions_staging WHERE session_id=?
                """)
                let moveMessages = try Statement(db, """
                INSERT INTO messages (session_id, message_id, seq, role, parent_id, content_json)
                SELECT session_id, message_id, seq, role, parent_id, content_json FROM messages_staging WHERE session_id=?
                """)
                let moveRefs = try Statement(db, """
                INSERT INTO session_files (session_id, file_id)
                SELECT session_id, file_id FROM session_files_staging WHERE session_id=?
                """)
                let clearTombstone = try Statement(db, "DELETE FROM tombstones WHERE entity_type='session' AND entity_id=?")
                for id in stagingIds {
                    bind(existing, index: 1, id)
                    if sqlite3_step(existing.handle) == SQLITE_ROW {
                        skipped += 1
                        existing.reset()
                        continue
                    }
                    existing.reset()
                    bind(clearTombstone, index: 1, id)
                    try step(clearTombstone)
                    clearTombstone.reset()
                    bind(moveSession, index: 1, id)
                    try step(moveSession)
                    moveSession.reset()
                    bind(moveMessages, index: 1, id)
                    try step(moveMessages)
                    moveMessages.reset()
                    bind(moveRefs, index: 1, id)
                    try step(moveRefs)
                    moveRefs.reset()
                    let meta = try Statement(db, "SELECT title, created_at, updated_at FROM sessions WHERE session_id=?")
                    bind(meta, index: 1, id)
                    if sqlite3_step(meta.handle) == SQLITE_ROW {
                        summaries.append([
                            "id": id,
                            "title": text(meta, column: 0) ?? "",
                            "createdAt": int(meta, column: 1),
                            "updatedAt": int(meta, column: 2),
                        ])
                    }
                    let refs = try Statement(db, "SELECT file_id FROM session_files WHERE session_id=?")
                    bind(refs, index: 1, id)
                    while sqlite3_step(refs.handle) == SQLITE_ROW {
                        if let fileId = text(refs, column: 0) { usedFileIds.insert(fileId) }
                    }
                }

                let fileStatement = try Statement(db, "SELECT file_id, sha256, size, mime, blob FROM files_staging")
                var stagedFiles: [(String, String, Int, String, Data)] = []
                while sqlite3_step(fileStatement.handle) == SQLITE_ROW {
                    guard let fileId = text(fileStatement, column: 0),
                          let sha256 = text(fileStatement, column: 1),
                          let blobData = data(fileStatement, column: 4), !blobData.isEmpty else { continue }
                    stagedFiles.append((fileId, sha256, int(fileStatement, column: 2), text(fileStatement, column: 3) ?? "", blobData))
                }
                for (fileId, sha256, size, mime, blobData) in stagedFiles where usedFileIds.contains(fileId) {
                    try writeBlobFile(digest: sha256, data: blobData)
                    let insert = try Statement(db, "INSERT OR REPLACE INTO attachments (file_id, sha256, size, mime, created_at) VALUES (?, ?, ?, ?, ?)")
                    bind(insert, index: 1, fileId)
                    bind(insert, index: 2, sha256)
                    bind(insert, index: 3, size)
                    bind(insert, index: 4, mime)
                    bind(insert, index: 5, Int(Date().timeIntervalSince1970 * 1000))
                    try step(insert)
                }

                try exec("DELETE FROM sessions_staging")
                try exec("DELETE FROM messages_staging")
                try exec("DELETE FROM session_files_staging")
                try exec("DELETE FROM files_staging")
                return ["summaries": summaries, "skipped": skipped, "revision": revision]
            }
            notify(entityType: "sessions", entityId: "*")
            return result
        }
    }

    // MARK: - IndexedDB → SQLite 迁移（E04）

    func migrationBegin(expectedSessions: Int, expectedFiles: Int) async throws {
        try await run { [self] in
            let mode = try metaValue("storage_mode") ?? "idb"
            guard mode == "idb" else {
                throw StorageError.invalidParameter("已完成迁移，无需重复")
            }
            try transaction {
                try exec("DELETE FROM sessions")
                try exec("DELETE FROM messages")
                try exec("DELETE FROM session_files")
                try exec("DELETE FROM attachments")
                try exec("DELETE FROM tombstones WHERE entity_type='session'")
                try exec("DELETE FROM sessions_staging")
                try exec("DELETE FROM messages_staging")
                try exec("DELETE FROM session_files_staging")
                try exec("DELETE FROM files_staging")
                let statement = try Statement(db, "INSERT OR REPLACE INTO meta (key, value) VALUES ('migration.expected', ?)")
                bind(statement, index: 1, "\(expectedSessions)|\(expectedFiles)")
                try step(statement)
                return 0
            }
        }
    }

    func migrationPutSession(json: String, sha256: String) async throws {
        try await run { [self] in
            let record = try parseSessionJSON(json)
            let digest = Self.sha256Hex(Data(json.utf8))
            guard digest == sha256 else {
                throw StorageError.invalidParameter("会话 \(record.id) 校验失败（hash 不一致），迁移已中止")
            }
            try transaction {
                try insertSessionRows(record: record, table: "sessions")
                return 0
            }
        }
    }

    // 迁移文件分块上传：blob_staging 暂存，finish 时落盘登记附件
    func migrationPutFileBegin(fileId: String, mime: String) async throws {
        try await run { [self] in
            try transaction {
                let statement = try Statement(db, "INSERT OR REPLACE INTO blob_staging (file_id, mime, data, updated_at) VALUES (?, ?, NULL, ?)")
                bind(statement, index: 1, fileId)
                bind(statement, index: 2, mime)
                bind(statement, index: 3, Int(Date().timeIntervalSince1970 * 1000))
                try step(statement)
                return 0
            }
        }
    }

    func migrationPutFileAppend(fileId: String, base64: String) async throws {
        guard let chunk = Data(base64Encoded: base64), !chunk.isEmpty else {
            throw StorageError.invalidParameter("分块编码无效")
        }
        try await run { [self] in
            try transaction {
                let read = try Statement(db, "SELECT data FROM blob_staging WHERE file_id=?")
                bind(read, index: 1, fileId)
                guard sqlite3_step(read.handle) == SQLITE_ROW else {
                    read.reset()
                    throw StorageError.invalidParameter("迁移文件会话不存在")
                }
                var existing = data(read, column: 0) ?? Data()
                read.reset()
                if existing.isEmpty { existing = Data() }
                existing.append(chunk)
                let update = try Statement(db, "UPDATE blob_staging SET data=?, updated_at=? WHERE file_id=?")
                sqlite3_bind_blob(update.handle, 1, (existing as NSData).bytes, Int32(existing.count), SQLITE_TRANSIENT)
                bind(update, index: 2, Int(Date().timeIntervalSince1970 * 1000))
                bind(update, index: 3, fileId)
                try step(update)
                return 0
            }
        }
    }

    func migrationPutFileFinish(fileId: String) async throws {
        try await run { [self] in
            try transaction {
                let statement = try Statement(db, "SELECT data, mime FROM blob_staging WHERE file_id=?")
                bind(statement, index: 1, fileId)
                guard sqlite3_step(statement.handle) == SQLITE_ROW,
                      let blobData = data(statement, column: 0), !blobData.isEmpty else {
                    throw StorageError.invalidParameter("迁移文件会话不存在或为空")
                }
                let mime = text(statement, column: 1) ?? ""
                let digest = Self.sha256Hex(blobData)
                try writeBlobFile(digest: digest, data: blobData)
                let insert = try Statement(db, "INSERT OR REPLACE INTO attachments (file_id, sha256, size, mime, created_at) VALUES (?, ?, ?, ?, ?)")
                bind(insert, index: 1, fileId)
                bind(insert, index: 2, digest)
                bind(insert, index: 3, blobData.count)
                bind(insert, index: 4, mime)
                bind(insert, index: 5, Int(Date().timeIntervalSince1970 * 1000))
                try step(insert)
                let deleteStaged = try Statement(db, "DELETE FROM blob_staging WHERE file_id=?")
                bind(deleteStaged, index: 1, fileId)
                try step(deleteStaged)
                return 0
            }
        }
    }

    /// 迁移提交：核对条数（E04）后切换正式存储模式；IndexedDB 原样保留作回滚备份。
    func migrationCommit(expectedSessions: Int, expectedFiles: Int) async throws -> [String: Any] {
        try await run { [self] in
            let result: [String: Any] = try transaction {
                let sessionCount = try Statement(db, "SELECT COUNT(*) FROM sessions")
                let fileCount = try Statement(db, "SELECT COUNT(*) FROM attachments")
                let actualSessions = try stepCount(sessionCount)
                let actualFiles = try stepCount(fileCount)
                guard actualSessions == expectedSessions, actualFiles == expectedFiles else {
                    throw StorageError.invalidParameter(
                        "迁移校验失败：会话 \(actualSessions)/\(expectedSessions)，附件 \(actualFiles)/\(expectedFiles)。已保持原存储不变。"
                    )
                }
                let statement = try Statement(db, "UPDATE meta SET value='sqlite' WHERE key='storage_mode'")
                try step(statement)
                let clear = try Statement(db, "DELETE FROM meta WHERE key='migration.expected'")
                try step(clear)
                return [
                    "mode": "sqlite",
                    "sessions": actualSessions,
                    "attachments": actualFiles,
                    "revision": revision,
                ]
            }
            notify(entityType: "storage", entityId: "mode")
            return result
        }
    }

    func migrationAbort() async throws {
        try await run { [self] in
            try transaction {
                try exec("DELETE FROM sessions")
                try exec("DELETE FROM messages")
                try exec("DELETE FROM session_files")
                try exec("DELETE FROM attachments")
                let statement = try Statement(db, "DELETE FROM meta WHERE key='migration.expected'")
                try step(statement)
                return 0
            }
        }
    }

    static func sha256Hex(_ data: Data) -> String {
        var digest = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        data.withUnsafeBytes { raw in
            _ = CC_SHA256(raw.baseAddress, CC_LONG(raw.count), &digest)
        }
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}
