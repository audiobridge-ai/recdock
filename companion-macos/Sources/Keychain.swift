import Foundation
import Security
import LocalAuthentication

enum ModelCredential {
    private static let service = "ai.recdock.companion.models"
    static func save(_ token: String) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "huggingface"]
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: Data(token.utf8)] as CFDictionary)
        if status == errSecItemNotFound {
            var item = query; item[kSecValueData as String] = Data(token.utf8)
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw CompanionFailure.message("无法保存模型授权到钥匙串。") }
        } else if status != errSecSuccess { throw CompanionFailure.message("无法更新钥匙串中的模型授权。") }
    }
    static func load() -> String? {
        let context = LAContext(); context.interactionNotAllowed = true
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "huggingface", kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne, kSecUseAuthenticationContext as String: context]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    static func remove() throws {
        let status = SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "huggingface"] as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw CompanionFailure.message("未能删除钥匙串中的模型授权。") }
    }
}
