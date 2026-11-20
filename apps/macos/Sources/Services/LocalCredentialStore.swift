import Darwin
import Foundation

/// The stored key is only exposed to native networking. Writes replace the private file atomically.
final class LocalCredentialStore {
    static let maxKeyBytes = 4096
    private static let filename = "api-key"

    let directory: URL
    let initialReadFailed: Bool
    private let lock = NSLock()
    private var key: String?

    init(directory: URL = LocalCredentialStore.defaultDirectory()) {
        self.directory = directory
        do {
            key = try Self.readKey(from: directory)
            initialReadFailed = false
        } catch {
            key = nil
            initialReadFailed = true
        }
    }

    static func isValidKey(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= maxKeyBytes
            && !value.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
    }

    static func defaultDirectory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent(Bundle.main.bundleIdentifier ?? "com.example.deepseekmac", isDirectory: true)
            .appendingPathComponent("Credentials", isDirectory: true)
    }

    func set(_ value: String?) throws {
        try lock.withLock {
            if let value {
                try writeKey(value)
            } else if let fd = try Self.openDirectory(directory) {
                defer { close(fd) }
                guard unlinkat(fd, Self.filename, 0) == 0 || errno == ENOENT else {
                    throw CredentialFileError.unavailable
                }
            }
            key = value
        }
    }

    func loadForNativeRequestsOnly() -> String? {
        lock.withLock { key }
    }

    private func writeKey(_ value: String) throws {
        guard Self.isValidKey(value) else { throw CredentialFileError.invalid }
        let bytes = Data(value.utf8)
        try FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]
        )
        guard let directoryFD = try Self.openDirectory(directory) else { throw CredentialFileError.unavailable }
        defer { close(directoryFD) }

        let temporary = ".api-key-\(UUID().uuidString)"
        let fd = openat(directoryFD, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw CredentialFileError.unavailable }
        defer { _ = unlinkat(directoryFD, temporary, 0) }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        guard fchmod(fd, 0o600) == 0 else { throw CredentialFileError.unavailable }
        try handle.write(contentsOf: bytes)
        try handle.synchronize()
        try handle.close()
        guard renameat(directoryFD, temporary, directoryFD, Self.filename) == 0 else {
            throw CredentialFileError.unavailable
        }
    }

    private static func readKey(from directory: URL) throws -> String? {
        guard let directoryFD = try openDirectory(directory) else { return nil }
        defer { close(directoryFD) }

        let fd = openat(directoryFD, filename, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        if fd < 0 && errno == ENOENT { return nil }
        guard fd >= 0 else { throw CredentialFileError.unavailable }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? handle.close() }
        guard ownedPrivateItem(fd, type: S_IFREG, permissions: 0o600),
              let bytes = try handle.read(upToCount: maxKeyBytes + 1),
              !bytes.isEmpty, bytes.count <= maxKeyBytes,
              let value = String(data: bytes, encoding: .utf8), isValidKey(value) else {
            throw CredentialFileError.invalid
        }
        return value
    }

    private static func openDirectory(_ directory: URL) throws -> Int32? {
        let fd = open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        if fd < 0 && errno == ENOENT { return nil }
        guard fd >= 0 else { throw CredentialFileError.unavailable }
        guard ownedPrivateItem(fd, type: S_IFDIR, permissions: 0o700) else {
            close(fd)
            throw CredentialFileError.unavailable
        }
        return fd
    }

    private static func ownedPrivateItem(_ fd: Int32, type: mode_t, permissions: mode_t) -> Bool {
        var info = stat()
        return fstat(fd, &info) == 0 && info.st_uid == geteuid()
            && (info.st_mode & S_IFMT) == type && (info.st_mode & 0o777) == permissions
    }

    private enum CredentialFileError: Error {
        case invalid
        case unavailable
    }
}
