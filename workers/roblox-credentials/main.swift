import Foundation
import Security

private let service = "com.forge.roblox.credentials.v2"

struct Request: Decodable {
    let operation: String
    let account: String
    let secret: String?
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

let input = FileHandle.standardInput.readDataToEndOfFile()
guard input.count > 0 && input.count <= 1_048_576 else { fail("credential request size is invalid") }
guard let request = try? JSONDecoder().decode(Request.self, from: input) else { fail("credential request is malformed") }
guard request.account.range(of: "^[A-Za-z0-9._:-]{1,200}$", options: .regularExpression) != nil else { fail("credential account is invalid") }

let base: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: request.account,
]

switch request.operation {
case "put":
    guard let secret = request.secret, let bytes = secret.data(using: .utf8), bytes.count > 0 && bytes.count <= 262_144 else { fail("credential secret is invalid") }
    let update = SecItemUpdate(base as CFDictionary, [kSecValueData as String: bytes] as CFDictionary)
    if update == errSecItemNotFound {
        var add = base
        add[kSecValueData as String] = bytes
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { fail("keychain add failed: \(status)") }
    } else if update != errSecSuccess { fail("keychain update failed: \(update)") }
    print("{\"status\":\"stored\"}")
case "get":
    var query = base
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { print("{\"status\":\"absent\"}"); exit(0) }
    guard status == errSecSuccess, let data = item as? Data, let secret = String(data: data, encoding: .utf8) else { fail("keychain read failed: \(status)") }
    let response = try! JSONSerialization.data(withJSONObject: ["status": "present", "secret": secret])
    FileHandle.standardOutput.write(response)
    FileHandle.standardOutput.write(Data("\n".utf8))
case "delete":
    let status = SecItemDelete(base as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { fail("keychain delete failed: \(status)") }
    print("{\"status\":\"deleted\"}")
default:
    fail("credential operation is unsupported")
}
