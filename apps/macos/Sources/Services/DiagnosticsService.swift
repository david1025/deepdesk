import Foundation
import AppKit

/// 诊断（T13）：分级滚动日志 + 「导出诊断信息」ZIP。
/// 日志原则（docs/07 T04 沿用）：只记方法名/错误码/状态码，不记聊天内容、不记密钥；
/// 消息经 redact 清洗（sk- 令牌打码、截断、压平换行）。
final class DiagnosticsService {
    static let shared = DiagnosticsService()

    static let maxFileBytes = 512 * 1024
    static let maxRotatedFiles = 3

    private let queue = DispatchQueue(label: "com.deepseek.mac.diagnostics")
    private let logDirectory: URL
    private static let activeLogName = "deepseek.log"

    private init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        logDirectory = base
            .appendingPathComponent(Bundle.main.bundleIdentifier ?? BundleDataMigration.bundleIdentifier, isDirectory: true)
            .appendingPathComponent("Logs", isDirectory: true)
        try? FileManager.default.createDirectory(at: logDirectory, withIntermediateDirectories: true)
    }

    enum Level: String {
        case debug = "DEBUG"
        case info = "INFO"
        case warn = "WARN"
        case error = "ERROR"
    }

    // MARK: - 日志

    func log(_ level: Level, _ category: String, _ message: String) {
        let line = Self.formatLine(level: level, category: category, message: message)
        NSLog("%@", line)
        queue.async { [logDirectory] in
            let target = logDirectory.appendingPathComponent(Self.activeLogName)
            if let handle = FileHandle(forWritingAtPath: target.path) {
                defer { try? handle.close() }
                let end = (try? handle.seekToEnd()) ?? 0
                try? handle.write(contentsOf: Data(line.utf8))
                if end > Self.maxFileBytes {
                    try? handle.close()
                    Self.rotate(directory: logDirectory)
                }
            } else {
                let lineData = Data(line.utf8)
                try? FileManager.default.createDirectory(at: logDirectory, withIntermediateDirectories: true)
                try? lineData.write(to: target, options: .atomic)
            }
        }
    }

    static func rotate(directory: URL) {
        let active = directory.appendingPathComponent(activeLogName)
        // deepseek.2.log ← .1 ← active；最旧删除
        let oldest = directory.appendingPathComponent("deepseek.\(maxRotatedFiles - 1).log")
        try? FileManager.default.removeItem(at: oldest)
        for index in stride(from: maxRotatedFiles - 2, through: 1, by: -1) {
            let source = directory.appendingPathComponent("deepseek.\(index).log")
            let target = directory.appendingPathComponent("deepseek.\(index + 1).log")
            try? FileManager.default.moveItem(at: source, to: target)
        }
        try? FileManager.default.moveItem(at: active, to: directory.appendingPathComponent("deepseek.1.log"))
    }

    /// 单行日志格式；消息脱敏并压平
    static func formatLine(level: Level, category: String, message: String) -> String {
        let timestamp = ISO8601DateFormatter().string(from: Date())
        let clean = redact(message)
            .replacingOccurrences(of: "\n", with: " ⏎ ")
            .replacingOccurrences(of: "\r", with: " ")
        return "\(timestamp) \(level.rawValue) [\(category)] \(clean)"
    }

    /// 脱敏：API Key 令牌打码；超长截断
    static func redact(_ text: String) -> String {
        var cleaned = text
        if let regex = try? NSRegularExpression(pattern: #"sk-[A-Za-z0-9_\-]{6,}"#) {
            let range = NSRange(cleaned.startIndex..., in: cleaned)
            cleaned = regex.stringByReplacingMatches(in: cleaned, range: range, withTemplate: "[redacted]")
        }
        if cleaned.count > 2000 {
            cleaned = String(cleaned.prefix(2000)) + "…[truncated]"
        }
        return cleaned
    }

    // MARK: - 诊断导出

    /// 汇总诊断 ZIP；返回导出文件 URL（用户取消返回 nil）。
    /// 内容：版本信息、存储统计、自检结果、最近日志。不含密钥与聊天内容。
    @MainActor
    func exportDiagnostics(storageSummary: @autoclosure () -> String) throws -> URL? {
        let panel = NSSavePanel()
        panel.title = "导出诊断信息"
        panel.nameFieldStringValue = "deepseek-diagnostics-\(Self.fileTimestamp()).zip"
        panel.allowedContentTypes = [.zip]
        guard panel.runModal() == .OK, let target = panel.url else { return nil }

        let staging = FileManager.default.temporaryDirectory
            .appendingPathComponent("deepseek-diag-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: staging.appendingPathComponent("logs"), withIntermediateDirectories: true)

        try Self.infoText().write(
            to: staging.appendingPathComponent("info.txt"), atomically: true, encoding: .utf8
        )
        try DiagnosticsService.redact(storageSummary()).write(
            to: staging.appendingPathComponent("storage.txt"), atomically: true, encoding: .utf8
        )
        if let selftest = Self.selftestResultURL(),
           let data = try? Data(contentsOf: selftest) {
            try data.write(to: staging.appendingPathComponent("selftest.json"))
        }
        for file in (try? FileManager.default.contentsOfDirectory(at: logDirectory, includingPropertiesForKeys: nil)) ?? []
        where file.pathExtension == "log" {
            try? FileManager.default.copyItem(at: file, to: staging.appendingPathComponent("logs").appendingPathComponent(file.lastPathComponent))
        }

        let entries = try Self.collectFiles(in: staging, relativeTo: staging)
        let zipData = try MiniZip.archive(entries: entries)
        try zipData.write(to: target, options: .atomic)
        try? FileManager.default.removeItem(at: staging)
        log(.info, "diag", "diagnostics exported to \(target.lastPathComponent)")
        return target
    }

    static func fileTimestamp() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return formatter.string(from: Date())
    }

    static func infoText() -> String {
        let processInfo = ProcessInfo.processInfo
        let osVersion = processInfo.operatingSystemVersionString
        let bundle = Bundle.main
        let version = bundle.infoDictionary?["DeepDeskReleaseVersion"] as? String
            ?? bundle.infoDictionary?["CFBundleShortVersionString"] as? String
            ?? "?"
        let build = bundle.infoDictionary?["CFBundleVersion"] as? String ?? "?"
        return """
        DeepSeek for Mac 诊断信息
        生成时间: \(ISO8601DateFormatter().string(from: Date()))
        版本: \(version) (\(build))
        系统: \(osVersion)
        架构: \(processInfo.hostDescription())
        启动时长: \(Int(processInfo.systemUptime))s
        说明: 本文件不含 API Key 与聊天内容；日志仅含操作名/错误码。
        """
    }

    static func selftestResultURL() -> URL? {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let url = base.appendingPathComponent("DeepSeekSelfTest", isDirectory: true)
            .appendingPathComponent("selftest.json")
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    private static func collectFiles(in directory: URL, relativeTo root: URL) throws -> [ZipEntry] {
        guard let enumerator = FileManager.default.enumerator(
            at: directory, includingPropertiesForKeys: [.isRegularFileKey]
        ) else {
            return []
        }
        var entries: [ZipEntry] = []
        let rootPath = root.path
        for case let url as URL in enumerator {
            let values = try? url.resourceValues(forKeys: [.isRegularFileKey])
            guard values?.isRegularFile == true else { continue }
            let filePath = url.path
            let relative = filePath.hasPrefix(rootPath + "/")
                ? String(filePath.dropFirst(rootPath.count + 1))
                : url.lastPathComponent
            entries.append(ZipEntry(name: relative, data: try Data(contentsOf: url)))
        }
        return entries
    }
}

// MARK: - 轻量 ZIP（store-only，无压缩）

struct ZipEntry {
    let name: String
    let data: Data
}

/// 最小 ZIP 写入器：store-only（method 0）+ CRC32。诊断包均为文本/小文件，无需压缩依赖。
enum MiniZip {
    private static let crcTable: [UInt32] = {
        (0..<256).map { value -> UInt32 in
            var crc = UInt32(value)
            for _ in 0..<8 {
                crc = (crc >> 1) ^ (crc & 1 == 1 ? 0xEDB88320 : 0)
            }
            return crc
        }
    }()

    static func crc32(_ data: Data) -> UInt32 {
        var crc: UInt32 = 0xFFFFFFFF
        for byte in data {
            crc = crcTable[Int((crc ^ UInt32(byte)) & 0xFF)] ^ (crc >> 8)
        }
        return crc ^ 0xFFFFFFFF
    }

    static func archive(entries: [ZipEntry]) throws -> Data {
        var output = Data()
        var central = Data()
        var offsets: [UInt32] = []

        let (dosTime, dosDate) = dosDateTime(Date())
        for entry in entries {
            let nameBytes = Data(entry.name.utf8)
            guard nameBytes.count <= 0xFFFF, entry.data.count <= 0xFFFFFFFF else {
                throw NSError(domain: "MiniZip", code: 1,
                              userInfo: [NSLocalizedDescriptionKey: "entry too large: \(entry.name)"])
            }
            let crc = crc32(entry.data)
            offsets.append(UInt32(output.count))
            // local file header
            output.appendContent(le32: 0x0403_4b50)
            output.appendContent(le16: 20)          // version needed
            output.appendContent(le16: 0x0800)      // UTF-8 名
            output.appendContent(le16: 0)           // method: store
            output.appendContent(le16: dosTime)
            output.appendContent(le16: dosDate)
            output.appendContent(le32: crc)
            output.appendContent(le32: UInt32(truncatingIfNeeded: entry.data.count))
            output.appendContent(le32: UInt32(truncatingIfNeeded: entry.data.count))
            output.appendContent(le16: UInt16(nameBytes.count))
            output.appendContent(le16: 0)           // extra len
            output.append(nameBytes)
            output.append(entry.data)
            // central directory record
            central.appendContent(le32: 0x0201_4b50)
            central.appendContent(le16: 20)
            central.appendContent(le16: 20)
            central.appendContent(le16: 0x0800)
            central.appendContent(le16: 0)
            central.appendContent(le16: dosTime)
            central.appendContent(le16: dosDate)
            central.appendContent(le32: crc)
            central.appendContent(le32: UInt32(truncatingIfNeeded: entry.data.count))
            central.appendContent(le32: UInt32(truncatingIfNeeded: entry.data.count))
            central.appendContent(le16: UInt16(nameBytes.count))
            central.appendContent(le16: 0)          // extra
            central.appendContent(le16: 0)          // comment
            central.appendContent(le16: 0)          // disk
            central.appendContent(le16: 0)          // internal attrs
            central.appendContent(le32: 0)          // external attrs
            central.appendContent(le32: offsets.last ?? 0)
            central.append(nameBytes)
        }

        let centralOffset = UInt32(output.count)
        output.append(central)
        // end of central directory
        output.appendContent(le32: 0x0605_4b50)
        output.appendContent(le16: 0)
        output.appendContent(le16: 0)
        output.appendContent(le16: UInt16(entries.count))
        output.appendContent(le16: UInt16(entries.count))
        output.appendContent(le32: UInt32(central.count))
        output.appendContent(le32: centralOffset)
        output.appendContent(le16: 0)
        return output
    }

    private static func dosDateTime(_ date: Date) -> (UInt16, UInt16) {
        let calendar = Calendar(identifier: .gregorian)
        let components = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        let year = max(components.year ?? 1980, 1980)
        let yearBits = (year - 1980) << 9
        let monthBits = (components.month ?? 1) << 5
        let day = components.day ?? 1
        let dosDate = UInt16(yearBits | monthBits | day)

        let hourBits = (components.hour ?? 0) << 11
        let minuteBits = (components.minute ?? 0) << 5
        let halfSeconds = (components.second ?? 0) / 2
        let dosTime = UInt16(hourBits | minuteBits | halfSeconds)
        return (dosTime, dosDate)
    }
}

private extension Data {
    mutating func appendContent(le16 value: UInt16) {
        append(UInt8(value & 0xFF))
        append(UInt8((value >> 8) & 0xFF))
    }
    mutating func appendContent(le32 value: UInt32) {
        append(UInt8(value & 0xFF))
        append(UInt8((value >> 8) & 0xFF))
        append(UInt8((value >> 16) & 0xFF))
        append(UInt8((value >> 24) & 0xFF))
    }
}

private extension ProcessInfo {
    /// 简短架构描述，避免引入受限 API
    func hostDescription() -> String {
        #if arch(arm64)
        return "arm64"
        #elseif arch(x86_64)
        return "x86_64"
        #else
        return "unknown"
        #endif
    }
}
