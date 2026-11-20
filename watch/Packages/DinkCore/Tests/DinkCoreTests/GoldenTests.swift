// The Swift copies of the JS code against the JS itself: fixtures from tools/pb-vectors.mjs (api/_pb.js, api/_watchrules.js, and the
// vendored qrcode-generator). `node tools/pb-vectors.mjs --check` in CI keeps the fixtures from going stale.
import XCTest
@testable import DinkCore

func fixture<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
    let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
    return try JSONDecoder().decode(type, from: Data(contentsOf: url))
}

final class GoldenTests: XCTestCase {
    struct Step: Decodable { let state: GameState; let call: [Int] }
    struct Vector: Decodable { let name: String; let cfg: GameConfig; let initial: GameState; let sides: [Int]; let steps: [Step] }

    func testScoringRulesMatchTheJavaScript() throws {
        let vectors = try fixture("pb-vectors", as: [Vector].self)
        XCTAssertGreaterThan(vectors.count, 20)
        var finished = 0
        for v in vectors {
            var s = Rules.newGame(v.cfg)
            XCTAssertEqual(s, v.initial, v.name + " start")
            for (i, side) in v.sides.enumerated() {
                s = Rules.rally(s, side)
                XCTAssertEqual(s, v.steps[i].state, "\(v.name) after tap \(i + 1)")
                XCTAssertEqual(s.call, v.steps[i].call, "\(v.name) call after tap \(i + 1)")
            }
            if s.isOver { finished += 1 }
        }
        XCTAssertGreaterThan(finished, 20, "most vectors play to the end, so the win and the stop are covered")
    }

    struct QRVector: Decodable { let text: String; let level: String; let version: Int; let rows: [String] }

    func testQRMatrixMatchesTheVendoredGenerator() throws {
        let vectors = try fixture("qr-vectors", as: [QRVector].self)
        XCTAssertGreaterThan(vectors.count, 30)
        for v in vectors {
            let qr = try QRMatrix(v.text, level: XCTUnwrap(QRLevel(rawValue: v.level)))
            XCTAssertEqual(qr.version, v.version, "\(v.level) \(v.text.prefix(30))")
            XCTAssertEqual(qr.rows, v.rows, "\(v.level) \(v.text.prefix(30))")
        }
    }

    func testTheWatchLinkFitsAComfortableQR() throws {
        let p = PairingSecrets(pairId: "0123456789abcdef0123456789abcdef", pollSecret: String(repeating: "1", count: 32), confirm4: "0042")
        let qr = try QRMatrix(p.qrText(base: "https://dinkscore.vercel.app/"), level: .M)
        XCTAssertEqual(p.qrText(base: "https://dinkscore.vercel.app/"), "https://dinkscore.vercel.app/#watch=0123456789abcdef0123456789abcdef")
        XCTAssertEqual(qr.version, 5)      // 37 modules: about 4 points a module on a 40 mm watch
    }

    func testTooLongTextIsRefused() {
        XCTAssertThrowsError(try QRMatrix(String(repeating: "x", count: 400), level: .L))
    }

    struct PairVector: Decodable { let pairId: String; let pollSecret: String; let idHash: String; let pollHash: String; let shortCode: String; let shortHash: String }

    func testPairingHashesMatchTheServerRules() throws {
        for v in try fixture("pairing-vectors", as: [PairVector].self) {
            let p = PairingSecrets(pairId: v.pairId, pollSecret: v.pollSecret, confirm4: "1234")
            XCTAssertEqual(p.idHash, v.idHash)
            XCTAssertEqual(p.pollHash, v.pollHash)
            XCTAssertEqual(p.shortCode, v.shortCode)
            XCTAssertEqual(p.shortHash, v.shortHash)
        }
    }

    func testFreshSecretsHaveTheShapeTheServerChecks() {
        let p = PairingSecrets.make()
        XCTAssertNotNil(p.pairId.range(of: "^[0-9a-f]{32}$", options: .regularExpression))
        XCTAssertNotNil(p.pollSecret.range(of: "^[0-9a-f]{32}$", options: .regularExpression))
        XCTAssertNotNil(p.confirm4.range(of: "^[0-9]{4}$", options: .regularExpression))
        XCTAssertNotNil(p.shortCode.range(of: "^[A-Z2-7]{6}$", options: .regularExpression))
        XCTAssertNotEqual(p.pairId, PairingSecrets.make().pairId)
        XCTAssertEqual(PairingSecrets.make(random: { Array(repeating: 0, count: $0) }).confirm4, "0000")
    }
}
