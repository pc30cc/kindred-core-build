import Foundation
import Security

/// Keychain-backed storage for the opaque session token.
///
/// The token is the whole session — anyone holding it is signed in as the
/// operator — so it goes in the Keychain and never into `UserDefaults`, which
/// is a plain plist inside the app container.
///
/// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` is the deliberate
/// choice: the app needs the token in the background to refresh the inbox
/// after a push, so it cannot require an unlocked device; but the token must
/// not travel to a restored backup on another device, so it is device-only.
enum TokenStore {

    private static let service = "com.webyar.native.session"
    private static let account = "sessionToken"

    static func save(_ token: String) {
        guard let data = token.data(using: .utf8) else { return }

        // SecItemUpdate cannot create a missing item, so delete-then-add is
        // the one sequence that is correct whether or not a token is stored.
        delete()

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemAdd(query as CFDictionary, nil)
        print("[KEYCHAIN] save status=\(status)")
    }

    static func read() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        print("[KEYCHAIN] read status=\(status)")
        guard status == errSecSuccess,
              let data = item as? Data,
              let token = String(data: data, encoding: .utf8),
              !token.isEmpty
        else { return nil }
        return token
    }

    static func delete() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
