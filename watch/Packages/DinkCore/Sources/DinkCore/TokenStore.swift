// The watch token lives in the Keychain, never in a file or in UserDefaults.
import Foundation
import Security

public protocol TokenStore: AnyObject {
    func load() -> String?
    func save(_ token: String)
    func clear()
}

public final class MemoryTokenStore: TokenStore {
    public var token: String?
    public init(_ token: String? = nil) { self.token = token }
    public func load() -> String? { token }
    public func save(_ token: String) { self.token = token }
    public func clear() { token = nil }
}

public final class KeychainTokenStore: TokenStore {
    private let service: String, account = "watch-token"
    public init(service: String = "dink-watch") { self.service = service }

    private var match: [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account] }

    public func load() -> String? {
        var query = match
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func save(_ token: String) {
        clear()
        var item = match
        item[kSecValueData as String] = Data(token.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly   // readable while the watch is on the wrist and locked
        SecItemAdd(item as CFDictionary, nil)
    }

    public func clear() { SecItemDelete(match as CFDictionary) }
}
