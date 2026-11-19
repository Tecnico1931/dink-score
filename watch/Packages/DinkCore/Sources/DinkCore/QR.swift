// A QR code encoder in plain Swift: watchOS has no CoreImage, so the pairing code has to be made here.
// Byte mode, versions 1 to 10 (up to 213 bytes at level L), all four error correction levels. It follows qrcode-generator 1.4.4 (MIT, Kazuhiko Arase),
// the library the club invite already uses, step for step, including how the mask is chosen, so the module matrix is the same one:
// Tests/DinkCoreTests/Fixtures/qr-vectors.json is made by tools/pb-vectors.mjs from that library and compared module by module.
import Foundation

public enum QRLevel: String, CaseIterable { case L, M, Q, H
    fileprivate var bits: Int { switch self { case .L: 1; case .M: 0; case .Q: 3; case .H: 2 } }
    fileprivate var index: Int { switch self { case .L: 0; case .M: 1; case .Q: 2; case .H: 3 } }
}

public struct QRMatrix: Equatable {
    public let version: Int
    public let size: Int
    private let modules: [[Bool]]

    public enum Failure: Error { case tooLong }

    public init(_ text: String, level: QRLevel = .M) throws {
        let bytes = Array(text.utf8)
        var found: (Int, [QRBlock])?
        for v in 1...10 {
            let blocks = QRTables.blocks(version: v, level: level)
            let capacity = blocks.reduce(0) { $0 + $1.data }
            if 4 + (v < 10 ? 8 : 16) + 8 * bytes.count <= 8 * capacity { found = (v, blocks); break }
        }
        guard let (v, blocks) = found else { throw Failure.tooLong }
        let data = QRBuild.codewords(bytes, version: v, blocks: blocks)
        var best = 0, bestPoint = 0.0
        for mask in 0..<8 {
            let point = QRBuild.lostPoint(QRBuild.make(version: v, level: level, data: data, mask: mask, test: true))
            if mask == 0 || bestPoint > point { bestPoint = point; best = mask }
        }
        version = v
        size = v * 4 + 17
        modules = QRBuild.make(version: v, level: level, data: data, mask: best, test: false)
    }

    public func isDark(_ row: Int, _ col: Int) -> Bool { modules[row][col] }
    /// One string per row, "1" for a dark module: the shape the golden vectors use.
    public var rows: [String] { modules.map { String($0.map { $0 ? "1" : "0" }) } }
}

struct QRBlock { let total: Int; let data: Int }

enum QRTables {
    // Per version 1...10, per level L, M, Q, H: runs of (count, total codewords, data codewords).
    static let rs: [[[Int]]] = [
        [[1, 26, 19], [1, 26, 16], [1, 26, 13], [1, 26, 9]],
        [[1, 44, 34], [1, 44, 28], [1, 44, 22], [1, 44, 16]],
        [[1, 70, 55], [1, 70, 44], [2, 35, 17], [2, 35, 13]],
        [[1, 100, 80], [2, 50, 32], [2, 50, 24], [4, 25, 9]],
        [[1, 134, 108], [2, 67, 43], [2, 33, 15, 2, 34, 16], [2, 33, 11, 2, 34, 12]],
        [[2, 86, 68], [4, 43, 27], [4, 43, 19], [4, 43, 15]],
        [[2, 98, 78], [4, 49, 31], [2, 32, 14, 4, 33, 15], [4, 39, 13, 1, 40, 14]],
        [[2, 121, 97], [2, 60, 38, 2, 61, 39], [4, 40, 18, 2, 41, 19], [4, 40, 14, 2, 41, 15]],
        [[2, 146, 116], [3, 58, 36, 2, 59, 37], [4, 36, 16, 4, 37, 17], [4, 36, 12, 4, 37, 13]],
        [[2, 86, 68, 2, 87, 69], [4, 69, 43, 1, 70, 44], [6, 43, 19, 2, 44, 20], [6, 43, 15, 2, 44, 16]],
    ]
    static let alignment: [[Int]] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]]

    static func blocks(version: Int, level: QRLevel) -> [QRBlock] {
        let run = rs[version - 1][level.index]
        var out: [QRBlock] = []
        for i in stride(from: 0, to: run.count, by: 3) { for _ in 0..<run[i] { out.append(QRBlock(total: run[i + 1], data: run[i + 2])) } }
        return out
    }

    // GF(256): the same two tables qrcode-generator builds.
    static let exp: [Int] = {
        var t = [Int](repeating: 0, count: 256)
        for i in 0..<8 { t[i] = 1 << i }
        for i in 8..<256 { t[i] = t[i - 4] ^ t[i - 5] ^ t[i - 6] ^ t[i - 8] }
        return t
    }()
    static let log: [Int] = {
        var t = [Int](repeating: 0, count: 256)
        for i in 0..<255 { t[exp[i]] = i }
        return t
    }()
    static func gexp(_ n: Int) -> Int { var n = n; while n < 0 { n += 255 }; while n >= 256 { n -= 255 }; return exp[n] }
}

enum QRBuild {
    // ---- polynomials over GF(256), highest power first, no leading zeros ----
    private static func poly(_ nums: [Int], shift: Int = 0) -> [Int] {
        let trimmed = Array(nums.drop { $0 == 0 })
        return trimmed + [Int](repeating: 0, count: shift)
    }
    private static func multiply(_ a: [Int], _ b: [Int]) -> [Int] {
        var out = [Int](repeating: 0, count: a.count + b.count - 1)
        for i in 0..<a.count { for j in 0..<b.count { out[i + j] ^= QRTables.gexp(QRTables.log[a[i]] + QRTables.log[b[j]]) } }
        return poly(out)
    }
    private static func mod(_ a: [Int], _ b: [Int]) -> [Int] {
        var a = a
        while a.count - b.count >= 0 && !a.isEmpty {
            let ratio = QRTables.log[a[0]] - QRTables.log[b[0]]
            for i in 0..<b.count { a[i] ^= QRTables.gexp(QRTables.log[b[i]] + ratio) }
            a = poly(a)
        }
        return a
    }
    private static func errorCorrectPolynomial(_ n: Int) -> [Int] {
        var a = [1]
        for i in 0..<n { a = multiply(a, [1, QRTables.gexp(i)]) }
        return a
    }

    // ---- the data and its error correction, interleaved ----
    private struct Bits {
        var bytes: [Int] = []; var count = 0
        mutating func put(_ value: Int, _ length: Int) { for i in 0..<length { bit(((value >> (length - i - 1)) & 1) == 1) } }
        mutating func bit(_ b: Bool) {
            if bytes.count <= count / 8 { bytes.append(0) }
            if b { bytes[count / 8] |= 0x80 >> (count % 8) }
            count += 1
        }
    }

    static func codewords(_ data: [UInt8], version: Int, blocks: [QRBlock]) -> [Int] {
        var buffer = Bits()
        buffer.put(4, 4)                                  // byte mode
        buffer.put(data.count, version < 10 ? 8 : 16)
        for b in data { buffer.put(Int(b), 8) }
        let total = blocks.reduce(0) { $0 + $1.data }
        if buffer.count + 4 <= total * 8 { buffer.put(0, 4) }
        while buffer.count % 8 != 0 { buffer.bit(false) }
        while true {
            if buffer.count >= total * 8 { break }
            buffer.put(236, 8)
            if buffer.count >= total * 8 { break }
            buffer.put(17, 8)
        }
        var offset = 0, maxDc = 0, maxEc = 0
        var dc: [[Int]] = [], ec: [[Int]] = []
        for block in blocks {
            let ecCount = block.total - block.data
            maxDc = max(maxDc, block.data); maxEc = max(maxEc, ecCount)
            let d = (0..<block.data).map { buffer.bytes[$0 + offset] & 0xff }
            offset += block.data
            let rs = errorCorrectPolynomial(ecCount)
            let rem = mod(poly(d, shift: rs.count - 1), rs)
            dc.append(d)
            ec.append((0..<(rs.count - 1)).map { i in let k = i + rem.count - (rs.count - 1); return k >= 0 ? rem[k] : 0 })
        }
        var out: [Int] = []
        for i in 0..<maxDc { for r in 0..<blocks.count where i < dc[r].count { out.append(dc[r][i]) } }
        for i in 0..<maxEc { for r in 0..<blocks.count where i < ec[r].count { out.append(ec[r][i]) } }
        return out
    }

    // ---- the matrix ----
    private static func digits(_ n: Int) -> Int { var n = n, d = 0; while n != 0 { d += 1; n >>= 1 }; return d }
    private static func typeInfo(_ data: Int) -> Int {
        var d = data << 10
        while digits(d) - digits(1335) >= 0 { d ^= 1335 << (digits(d) - digits(1335)) }
        return ((data << 10) | d) ^ 21522
    }
    private static func typeNumber(_ data: Int) -> Int {
        var d = data << 12
        while digits(d) - digits(7973) >= 0 { d ^= 7973 << (digits(d) - digits(7973)) }
        return (data << 12) | d
    }
    private static func masked(_ mask: Int, _ i: Int, _ j: Int) -> Bool {
        switch mask {
        case 0: return (i + j) % 2 == 0
        case 1: return i % 2 == 0
        case 2: return j % 3 == 0
        case 3: return (i + j) % 3 == 0
        case 4: return (i / 2 + j / 3) % 2 == 0
        case 5: return i * j % 2 + i * j % 3 == 0
        case 6: return (i * j % 2 + i * j % 3) % 2 == 0
        default: return (i * j % 3 + (i + j) % 2) % 2 == 0
        }
    }

    static func make(version: Int, level: QRLevel, data: [Int], mask: Int, test: Bool) -> [[Bool]] {
        let n = version * 4 + 17
        var m = [[Bool?]](repeating: [Bool?](repeating: nil, count: n), count: n)
        func probe(_ row: Int, _ col: Int) {
            for r in -1...7 where row + r > -1 && row + r < n {
                for c in -1...7 where col + c > -1 && col + c < n {
                    m[row + r][col + c] = (0...6 ~= r && (c == 0 || c == 6)) || (0...6 ~= c && (r == 0 || r == 6)) || (2...4 ~= r && 2...4 ~= c)
                }
            }
        }
        probe(0, 0); probe(n - 7, 0); probe(0, n - 7)
        let pos = QRTables.alignment[version - 1]
        for row in pos { for col in pos where m[row][col] == nil {
            for r in -2...2 { for c in -2...2 { m[row + r][col + c] = r == -2 || r == 2 || c == -2 || c == 2 || (r == 0 && c == 0) } }
        } }
        for r in 8..<(n - 8) where m[r][6] == nil { m[r][6] = r % 2 == 0 }
        for c in 8..<(n - 8) where m[6][c] == nil { m[6][c] = c % 2 == 0 }
        let info = typeInfo(level.bits << 3 | mask)
        for i in 0..<15 {
            let dark = !test && (info >> i) & 1 == 1
            if i < 6 { m[i][8] = dark } else if i < 8 { m[i + 1][8] = dark } else { m[n - 15 + i][8] = dark }
            if i < 8 { m[8][n - i - 1] = dark } else if i < 9 { m[8][15 - i - 1 + 1] = dark } else { m[8][15 - i - 1] = dark }
        }
        m[n - 8][8] = !test
        if version >= 7 {
            let bits = typeNumber(version)
            for i in 0..<18 {
                let dark = !test && (bits >> i) & 1 == 1
                m[i / 3][i % 3 + n - 8 - 3] = dark
                m[i % 3 + n - 8 - 3][i / 3] = dark
            }
        }
        // The data, in the zig-zag order of the standard.
        var inc = -1, row = n - 1, bitIndex = 7, byteIndex = 0
        var col = n - 1
        while col > 0 {
            if col == 6 { col -= 1 }
            while true {
                for c in 0..<2 where m[row][col - c] == nil {
                    var dark = byteIndex < data.count && (data[byteIndex] >> bitIndex) & 1 == 1
                    if masked(mask, row, col - c) { dark.toggle() }
                    m[row][col - c] = dark
                    bitIndex -= 1
                    if bitIndex == -1 { byteIndex += 1; bitIndex = 7 }
                }
                row += inc
                if row < 0 || n <= row { row -= inc; inc = -inc; break }
            }
            col -= 2
        }
        return m.map { $0.map { $0 ?? false } }
    }

    // The penalty score that picks the mask (lower is better); Double because the last term is a ratio, as in the JS.
    static func lostPoint(_ m: [[Bool]]) -> Double {
        let n = m.count
        var lost = 0.0
        for row in 0..<n { for col in 0..<n {
            var same = 0
            let dark = m[row][col]
            for r in -1...1 where row + r >= 0 && row + r < n {
                for c in -1...1 where col + c >= 0 && col + c < n && !(r == 0 && c == 0) && dark == m[row + r][col + c] { same += 1 }
            }
            if same > 5 { lost += Double(3 + same - 5) }
        } }
        for row in 0..<(n - 1) { for col in 0..<(n - 1) {
            let count = [m[row][col], m[row + 1][col], m[row][col + 1], m[row + 1][col + 1]].filter { $0 }.count
            if count == 0 || count == 4 { lost += 3 }
        } }
        for row in 0..<n { for col in 0..<(n - 6) where m[row][col] && !m[row][col + 1] && m[row][col + 2] && m[row][col + 3] && m[row][col + 4] && !m[row][col + 5] && m[row][col + 6] { lost += 40 } }
        for col in 0..<n { for row in 0..<(n - 6) where m[row][col] && !m[row + 1][col] && m[row + 2][col] && m[row + 3][col] && m[row + 4][col] && !m[row + 5][col] && m[row + 6][col] { lost += 40 } }
        let dark = m.reduce(0) { $0 + $1.filter { $0 }.count }
        lost += abs(100.0 * Double(dark) / Double(n) / Double(n) - 50) / 5 * 10
        return lost
    }
}
