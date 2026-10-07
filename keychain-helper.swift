import Foundation
import Security
import AppKit

// All input and key material use pipes, never argv, diagnostics, or a file.
func finish(_ result: [String: Any], _ code: Int32 = 0) -> Never {
    if let bytes = try? JSONSerialization.data(withJSONObject: result) {
        FileHandle.standardOutput.write(bytes)
    }
    exit(code)
}
let input = FileHandle.standardInput.readDataToEndOfFile()
if input.count < 65536,
   let request = (try? JSONSerialization.jsonObject(with: input)) as? [String: Any],
   request["operation"] as? String == "open-browser",
   let value = request["url"] as? String, let url = URL(string: value),
   url.scheme == "https", url.host == "auth.openai.com", url.path == "/api/accounts/authorize" {
    finish(["ok": NSWorkspace.shared.open(url)])
}
guard input.count < 4096,
      let request = (try? JSONSerialization.jsonObject(with: input)) as? [String: Any],
      let service = request["service"] as? String,
      let account = request["account"] as? String,
      !service.isEmpty, service.count < 200, !account.isEmpty, account.count < 200,
      let operation = request["operation"] as? String, ["get", "get-or-create"].contains(operation)
else { finish(["ok": false, "code": "invalid_request"], 1) }
let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
    kSecMatchLimit as String: kSecMatchLimitOne,
    kSecReturnData as String: true
]
var result: CFTypeRef?
var status = SecItemCopyMatching(query as CFDictionary, &result)
if status == errSecItemNotFound && operation == "get-or-create" {
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess
    else { finish(["ok": false, "code": "keychain_unavailable"], 1) }
    let item: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        kSecValueData as String: Data(bytes)
    ]
    status = SecItemAdd(item as CFDictionary, nil)
    guard status == errSecSuccess || status == errSecDuplicateItem
    else { finish(["ok": false, "code": "keychain_unavailable"], 1) }
    status = SecItemCopyMatching(query as CFDictionary, &result)
}
guard status == errSecSuccess, let key = result as? Data, key.count == 32
else { finish(["ok": false, "code": status == errSecItemNotFound ? "key_not_found" : "keychain_unavailable"], 1) }
finish(["ok": true, "key": key.base64EncodedString()])
