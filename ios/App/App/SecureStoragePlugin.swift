import Foundation
import Capacitor

/**
 * Keychain-backed storage for the app's opaque session token.
 *
 * The web view must NEVER hold the session token in localStorage,
 * sessionStorage or Capacitor Preferences (plain, backed-up, and readable by
 * anything in the web view). This plugin stores it in the iOS Keychain with
 * `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, so the token:
 *   - survives app restarts, device restarts and app updates (persistent
 *     login is a product requirement),
 *   - is available to background/launch code after the first unlock,
 *   - never leaves the device via iCloud Keychain or encrypted backups.
 */
@objc(SecureStoragePlugin)
public class SecureStoragePlugin: CAPPlugin, CAPBridgedPlugin {

    // Capacitor 6+ requires Swift plugins to declare their bridge metadata.
    public let identifier = "SecureStoragePlugin"
    public let jsName = "SecureStorage"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
    ]

    private let service = "com.webyar.app.securestorage"

    private func query(for key: String) -> [String: Any] {
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }

    @objc func get(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("key is required")
            return
        }
        var q = query(for: key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &item)
        if status == errSecSuccess, let data = item as? Data,
           let value = String(data: data, encoding: .utf8) {
            call.resolve(["value": value])
        } else if status == errSecItemNotFound {
            call.resolve(["value": NSNull()])
        } else {
            // A Keychain error is a device-level failure, not "logged out";
            // the JS layer treats a rejection as "unknown", never as logout.
            call.reject("Keychain read failed (status \(status))")
        }
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), let value = call.getString("value") else {
            call.reject("key and value are required")
            return
        }
        let data = Data(value.utf8)
        let q = query(for: key)
        SecItemDelete(q as CFDictionary)

        var insert = q
        insert[kSecValueData as String] = data
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

        let status = SecItemAdd(insert as CFDictionary, nil)
        if status == errSecSuccess {
            call.resolve()
        } else {
            call.reject("Keychain write failed (status \(status))")
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("key is required")
            return
        }
        let status = SecItemDelete(query(for: key) as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound {
            call.resolve()
        } else {
            call.reject("Keychain delete failed (status \(status))")
        }
    }
}
