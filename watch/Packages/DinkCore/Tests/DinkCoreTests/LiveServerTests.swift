// The Swift client against the real API handlers over HTTP. Skipped unless tools/watch-swift-check.mjs has started a throwaway server
// (DINK_TEST_URL and friends); it needs no network beyond that local port.
import XCTest
@testable import DinkCore

@MainActor
final class LiveServerTests: XCTestCase {
    var env: [String: String] { ProcessInfo.processInfo.environment }

    func phone(_ body: [String: Any]) async throws -> [String: Any] {
        var r = URLRequest(url: URL(string: env["DINK_TEST_URL"]! + "/api/live")!)
        r.httpMethod = "POST"; r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, _) = try await URLSession.shared.data(for: r)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testWatchLinksScoresAndUnlinks() async throws {
        guard let url = env["DINK_TEST_URL"], let code = env["DINK_TEST_CODE"], let game = env["DINK_TEST_GAME"], let secret = env["DINK_TEST_SECRET"] else {
            throw XCTSkip("run tools/watch-swift-check.mjs to start the throwaway API")
        }
        let client = DinkClient(baseURL: URL(string: url)!)
        let tokens = MemoryTokenStore(), box = MemoryOutboxStore()
        let s = WatchSession(api: client, tokens: tokens, outbox: box, base: url, label: "Swift check watch")

        // 1. The watch registers and shows a QR; the phone claims it with the typed 4 numbers and sends the game along.
        await s.tick()
        let p = try XCTUnwrap(s.pairing, "register failed: \(s.notice ?? "")")
        XCTAssertTrue(p.qrText.hasSuffix("/#watch=" + p.secrets.pairId + "." + p.confirm4))
        await s.tick()
        XCTAssertEqual(s.link, .unlinked, "nobody has claimed it yet")
        let wrong = try await phone(["code": code, "action": "watch-claim", "pair": p.secrets.pairId, "confirm4": p.confirm4 == "0000" ? "1111" : "0000"])
        XCTAssertNotNil(wrong["error"], "wrong numbers are refused")
        let claim = try await phone(["code": code, "action": "watch-claim", "pair": p.secrets.shortCode, "confirm4": p.confirm4, "game": game, "secret": secret])
        XCTAssertEqual(claim["attached"] as? String, game, "the typed 6 characters work like the QR: \(claim)")

        // 2. The watch collects its token once and follows the game.
        await s.tick()
        XCTAssertEqual(s.link, .linked)
        XCTAssertEqual(s.clubName, "Swift check club")
        XCTAssertNotNil(tokens.load())
        await s.tick()
        XCTAssertEqual(s.gameId, game)
        XCTAssertEqual(s.game?.cfg.teams, [["Ana", "Ben"], ["Cy", "Di"]])
        XCTAssertEqual(s.game?.call, [0, 0, 2])

        // 3. Taps reach the server and the watch ends up showing exactly what the server holds.
        s.score(side: 0); s.score(side: 0); s.score(side: 0)
        await s.flush()
        XCTAssertEqual(s.model.pending.count, 0)
        XCTAssertEqual(s.game?.score, [3, 0])
        let token = try XCTUnwrap(tokens.load())
        guard case .changed(let server, _) = try await client.fetchState(token: token, etag: nil) else { return XCTFail() }
        XCTAssertEqual(server.game?.state.score, [3, 0])
        XCTAssertEqual(server.game?.state.call, s.game?.call)
        XCTAssertEqual(s.game?.right, [1, 0], "the whole state came back with the last tap: three points, so Ana and Ben have swapped sides")

        // 4. A tap the server already has (answer lost, watch retries) counts once.
        let first = try await client.rally(token: token, opId: "swift-check-0001", side: 0, game: game)
        XCTAssertFalse(first.duplicate)
        XCTAssertEqual(first.state.score, [4, 0])
        let again = try await client.rally(token: token, opId: "swift-check-0001", side: 0, game: game)
        XCTAssertTrue(again.duplicate)
        XCTAssertEqual(again.state.score, [4, 0], "counted once")
        XCTAssertEqual(again.state, first.state)

        // 5. Undo takes the last point back, and the phone's view of the same game agrees.
        let undone = try await client.unrally(token: token, opId: "swift-check-0002", game: game)
        XCTAssertEqual(undone.state.score, [3, 0])
        let tag = try await client.fetchState(token: token, etag: nil)
        guard case .changed(_, let etag) = tag else { return XCTFail() }
        let quiet = try await client.fetchState(token: token, etag: etag)
        XCTAssertEqual(quiet, .unchanged, "a poll that finds nothing new is a 304")

        // 6. A game that was not sent to this watch is refused with 404 (the queue would be dropped).
        do { _ = try await client.rally(token: token, opId: "swift-check-0003", side: 0, game: "live-other"); XCTFail() }
        catch let e as DinkError { XCTAssertEqual(e.reaction, .dropQueue) }

        // 7. Unlinked from the phone: the watch's next call is a 401 and it goes back to the QR with its token cleared.
        let list = try await phone(["code": code, "action": "watch-list"])
        let link = try XCTUnwrap((list["links"] as? [[String: Any]])?.first?["id"] as? String)
        _ = try await phone(["code": code, "action": "watch-revoke", "link": link, "revokeKey": try XCTUnwrap(claim["revokeKey"] as? String)])
        await s.refresh()
        XCTAssertEqual(s.link, .unlinked)
        XCTAssertNil(tokens.load())
    }

    /// A watch with no club: the scoring phone shows a game code, the watch types it, and the link holds that one game until the game ends.
    func testAGameCodeLinksOneGameAndEndsWithIt() async throws {
        guard let url = env["DINK_TEST_URL"], let code = env["DINK_TEST_CODE"] else {
            throw XCTSkip("run tools/watch-swift-check.mjs to start the throwaway API")
        }
        // Its own game, so the other test's game is untouched when this one ends it.
        let game = "live-swift-solo", secret = "soloSecret123"
        let cfg: [String: Any] = ["mode": "doubles", "scoring": "sideout", "target": 11, "winBy": 2, "teams": [["Ana", "Ben"], ["Cy", "Di"]]]
        let fresh: [String: Any] = ["cfg": cfg, "score": [0, 0], "serving": 0, "serverNum": 2, "right": [0, 0], "server": 0, "rallies": 0, "switched": false, "justSwitched": false, "winner": NSNull(), "startedAt": 2, "endedAt": NSNull()]
        let published = try await phone(["code": code, "action": "state", "id": game, "secret": secret, "state": fresh, "ack": 0])
        XCTAssertNil(published["error"], "\(published)")
        let tokens = MemoryTokenStore(), box = MemoryOutboxStore()
        let s = WatchSession(api: DinkClient(baseURL: URL(string: url)!), tokens: tokens, outbox: box, base: url, label: "Swift game watch")
        let offered = try await phone(["code": code, "action": "watch-offer", "game": game, "secret": secret])
        let shown = try XCTUnwrap(offered["offer"] as? [String: Any], "\(offered)")
        let short = try XCTUnwrap(shown["short"] as? String), numbers = try XCTUnwrap(shown["confirm4"] as? String)

        await s.join(code: short, digits: numbers == "0000" ? "1111" : "0000")
        XCTAssertEqual(s.link, .unlinked, "wrong numbers do not link: \(s.notice ?? "")")
        await s.join(code: Hashes.spaced(short).lowercased(), digits: numbers)
        XCTAssertEqual(s.link, .linked, "the code as typed on a watch (spaced, any case) works: \(s.notice ?? "")")
        XCTAssertTrue(s.gameOnly); XCTAssertEqual(s.clubName, "")
        await s.refresh()
        XCTAssertEqual(s.gameId, game); XCTAssertTrue(s.gameOnly)
        s.score(side: 0); await s.flush()
        XCTAssertEqual(s.model.pending.count, 0)

        let token = try XCTUnwrap(tokens.load())
        let client = DinkClient(baseURL: URL(string: url)!)
        do { _ = try await client.rally(token: token, opId: "swift-game-0001", side: 0, game: "live-other"); XCTFail() }
        catch let e as DinkError { XCTAssertEqual(e.reaction, .dropQueue, "any other game is out of reach") }

        _ = try await phone(["code": code, "action": "end", "id": game, "secret": secret])
        await s.refresh()
        XCTAssertEqual(s.link, .unlinked, "the phone ended the game, so the link ended")
        XCTAssertNil(tokens.load()); XCTAssertEqual(s.notice, "This game's link has ended.")
    }
}
