import Foundation
import Security

/// API Key 不允许通过读取接口回传到网页。原生网络层应直接从 Keychain 读取。
final class KeychainService {
    private let account = "deepseek-api-key"
    private var service: String { Bundle.main.bundleIdentifier ?? "com.example.deepseekmac" }

    func exists() -> Bool {
        var result: CFTypeRef?
        let status = SecItemCopyMatching([
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecMatchLimit: kSecMatchLimitOne,
            kSecReturnAttributes: true
        ] as CFDictionary, &result)
        return status == errSecSuccess
    }

    func save(_ value: String) throws {
        guard !value.isEmpty else { throw KeychainError.emptyKey }
        guard let data = value.data(using: .utf8) else { throw KeychainError.invalidEncoding }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        let attributes: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var create = query
            create[kSecValueData as String] = data
            create[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let created = SecItemAdd(create as CFDictionary, nil)
            guard created == errSecSuccess else { throw KeychainError.osStatus(created) }
        } else if status != errSecSuccess {
            throw KeychainError.osStatus(status)
        }
    }

    func loadForNativeRequestsOnly() throws -> String? {
        var result: CFTypeRef?
        let status = SecItemCopyMatching([
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecMatchLimit: kSecMatchLimitOne,
            kSecReturnData: true
        ] as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess,
              let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else {
            throw KeychainError.osStatus(status)
        }
        return value
    }

    func delete() throws {
        let status = SecItemDelete([
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account
        ] as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.osStatus(status)
        }
    }
}

enum KeychainError: Error {
    case emptyKey
    case invalidEncoding
    case osStatus(OSStatus)
}
