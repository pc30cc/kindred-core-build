import Foundation
import OSLog
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

    /// The Keychain refuses every write from an app without an
    /// `application-identifier` entitlement, which is what an unsigned build
    /// is. It answers `errSecMissingEntitlement` and the app carries on
    /// perfectly well — until the next launch, when the session is gone and
    /// the operator is asked to sign in again with nothing to explain it.
    ///
    /// This file used to discard every status code, so that failure was
    /// invisible. It is now logged: whatever else goes wrong with a session,
    /// it will not be a mystery.
    private static let log = Logger(subsystem: "com.webyar.native", category: "keychain")

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
        if status != errSecSuccess {
            log.error("Could not store the session token (OSStatus \(status)). The operator will have to sign in again on the next launch.")
        }
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
        // `errSecItemNotFound` is the ordinary "nobody is signed in" answer
        // and is not worth a line in the log; anything else is.
        if status != errSecSuccess, status != errSecItemNotFound {
            log.error("Could not read the session token (OSStatus \(status)).")
        }
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
