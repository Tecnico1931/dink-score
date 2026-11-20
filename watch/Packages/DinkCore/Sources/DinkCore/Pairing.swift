// What the watch shows to be linked (QR, 4 digits, typed code) and what it sends instead of the raw ids. Mirrors api/_watchrules.js:
// the server stores only these hashes, so nothing in its database can be replayed to take over a pairing.
import Foundation
import CryptoKit
import Security

public enum SecureRandom {
    public static func bytes(_ n: Int) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: n)
        let status = SecRandomCopyBytes(kSecRandomDefault, n, &out)
        precondition(status == errSecSuccess, "no secure random numbers")
        return out
    }
}

public struct PairingSecrets: Equatable {
    public let pairId: String        // 32 hex: in the QR, never sent as is
    public let pollSecret: String    // 32 hex: proves this watch is the one that made the pairing
    public let confirm4: String      // 4 digits the phone asks for, so a photo of the QR is not enough

    public init(pairId: String, pollSecret: String, confirm4: String) { self.pairId = pairId; self.pollSecret = pollSecret; self.confirm4 = confirm4 }

    public static func make(random: (Int) -> [UInt8] = SecureRandom.bytes) -> PairingSecrets {
        let digits = random(4).reduce(UInt32(0)) { $0 << 8 | UInt32($1) } % 10000
        return PairingSecrets(pairId: hex(random(16)), pollSecret: hex(random(16)), confirm4: String(format: "%04d", digits))
    }

    public var idHash: String { Hashes.sha256("watch-id:" + pairId) }
    public var pollHash: String { Hashes.sha256("watch-poll:" + pollSecret) }
    /// The 6 characters to type when the camera is no use: the first 30 bits of the pairing id in base 32.
    public var shortCode: String { Hashes.shortCode(pairId) }
    public var shortHash: String { Hashes.sha256("watch-short:" + shortCode) }
    /// The text of the QR code. The id and the 4 digits are in the fragment (`#watch=<id>.<digits>`), so they never reach a server log or a
    /// Referer header. Seeing the QR means seeing the watch, so carrying the digits adds no weaker way in; the typed code still asks for them.
    public func qrText(base: String) -> String {
        var b = base
        while b.hasSuffix("/") { b.removeLast() }
        return b + "/#watch=" + pairId + "." + confirm4
    }
}

func hex(_ bytes: [UInt8]) -> String { bytes.map { String(format: "%02x", $0) }.joined() }

public enum Hashes {
    public static func sha256(_ s: String) -> String { hex(Array(SHA256.hash(data: Data(s.utf8)))) }

    private static let b32 = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")
    public static func shortCode(_ pairId: String) -> String {
        let v = (UInt32(pairId.prefix(8), radix: 16) ?? 0) >> 2
        return String((0..<6).map { b32[Int((v >> UInt32(25 - 5 * $0)) & 31)] })
    }
    /// "ABCDEF" -> "ABC DEF", easier to read and type.
    public static func spaced(_ code: String) -> String { code.count == 6 ? code.prefix(3) + " " + code.suffix(3) : code }
}
