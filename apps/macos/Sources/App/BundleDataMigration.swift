import AppKit
import Darwin
import Foundation

/// Seed the new bundle's storage before SQLite or WebKit opens it.
enum BundleDataMigration {
    static let bundleIdentifier = "com.david.deepdesk"
    static let legacyBundleIdentifier = "com.example.deepseekmac"

    @MainActor
    static func prepareForLaunch() throws {
        guard Bundle.main.bundleIdentifier == bundleIdentifier else { return }
        let library = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
        try migrate(in: library, from: legacyBundleIdentifier, to: bundleIdentifier) {
            !NSRunningApplication.runningApplications(withBundleIdentifier: legacyBundleIdentifier).isEmpty
        }
    }

    static func migrate(in library: URL, from legacy: String, to current: String,
                        legacyIsRunning: () -> Bool) throws {
        let manager = FileManager.default
        for name in ["Application Support", "WebKit"] {
            let parent = library.appendingPathComponent(name, isDirectory: true)
            let source = parent.appendingPathComponent(legacy, isDirectory: true)
            let destination = parent.appendingPathComponent(current, isDirectory: true)
            guard try existingDirectory(source), try !existingDirectory(destination) else { continue }
            guard !legacyIsRunning() else { throw MigrationError.legacyRunning }
            let staging = parent.appendingPathComponent(".deepdesk-migration-\(UUID().uuidString)", isDirectory: true)
            try manager.createDirectory(at: staging, withIntermediateDirectories: false,
                                        attributes: [.posixPermissions: 0o700])
            defer { try? manager.removeItem(at: staging) }
            let snapshot = staging.appendingPathComponent("snapshot", isDirectory: true)
            try manager.copyItem(at: source, to: snapshot)
            guard !legacyIsRunning() else { throw MigrationError.legacyRunning }
            if renamex_np(snapshot.path, destination.path, UInt32(RENAME_EXCL)) != 0 {
                guard errno == EEXIST, try existingDirectory(destination) else {
                    throw MigrationError.couldNotPublish
                }
            }
        }
    }

    private static func existingDirectory(_ url: URL) throws -> Bool {
        var info = stat()
        if lstat(url.path, &info) == 0 {
            guard info.st_mode & S_IFMT == S_IFDIR else { throw MigrationError.unexpectedFile }
            return true
        }
        if errno == ENOENT { return false }
        throw MigrationError.unexpectedFile
    }

    enum MigrationError: Error {
        case legacyRunning
        case unexpectedFile
        case couldNotPublish
    }
}
