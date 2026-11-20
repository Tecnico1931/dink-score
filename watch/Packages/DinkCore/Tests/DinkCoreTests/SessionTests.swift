// The outbox, the optimistic score and the session's reactions, against a scripted API (no network).
import XCTest
@testable import DinkCore

final class FakeAPI: WatchAPI, @unchecked Sendable {
    var server: GameState
    var version = 1
    var seen: [String] = []              // tap ids the server has applied
    var calls: [String] = []
    var failNext: [DinkError] = []
    var loseAnswerFor: Set<String> = []  // applied, but the answer never arrives
    var linkOnPoll = false
    var listed = true
    var finishError: DinkError?
    var joinReply: PollReply = .linked(token: "w_" + String(repeating: "c", count: 64), clubName: "", link: LinkInfo(id: "g1", label: nil, game: "live-1"))
    var joinError: DinkError?
    var joined: [String] = []
    var stateLink = "{\"id\":\"l1\",\"label\":null}"

    init(_ s: GameState) { server = s }

    func register(_ p: PairingSecrets, label: String) async throws { calls.append("register") }
    func poll(_ p: PairingSecrets) async throws -> PollReply {
        calls.append("poll")
        return linkOnPoll ? .linked(token: "w_" + String(repeating: "a", count: 64), clubName: "Test club", link: LinkInfo(id: "l1", label: nil)) : .waiting
    }
    func join(code: String, confirm4: String, label: String) async throws -> PollReply {
        calls.append("join"); joined.append(code + " " + confirm4)
        if let e = joinError { throw e }
        return joinReply
    }
    func fetchState(token: String, etag: String?) async throws -> StateFetch {
        calls.append("state")
        if let e = failNext.first { failNext.removeFirst(); throw e }
        let json = listed ? """
        {"club":{"name":"Test club"},"link":\(stateLink),"game":{"id":"live-1","version":\(version),"cfg":\(String(data: try JSONEncoder().encode(server.cfg), encoding: .utf8)!),"score":\(server.score),"serving":\(server.serving),"server":\(server.server),"serverNum":\(server.serverNum),"winner":\(server.winner.map(String.init) ?? "null"),"rallies":\(server.rallies)}}
        """ : "{\"club\":{\"name\":\"Test club\"},\"link\":{\"id\":\"l1\",\"label\":null},\"game\":null}"
        return .changed(try JSONDecoder().decode(StateReply.self, from: Data(json.utf8)), etag: "\"v\(version)\"")
    }
    private func tap(_ opId: String, _ apply: () -> Void) throws -> TapReply {
        if let e = failNext.first { failNext.removeFirst(); throw e }
        let duplicate = seen.contains(opId)
        if !duplicate { seen.append(opId); apply(); version += 1 }
        if loseAnswerFor.contains(opId) { loseAnswerFor.remove(opId); throw DinkError.offline("lost") }
        return try JSONDecoder().decode(TapReply.self, from: JSONSerialization.data(withJSONObject: ["state": try JSONSerialization.jsonObject(with: JSONEncoder().encode(server)), "version": version, "duplicate": duplicate]))
    }
    func rally(token: String, opId: String, side: Int, game: String) async throws -> TapReply {
        calls.append("rally"); return try tap(opId) { server = Rules.rally(server, side) }
    }
    func unrally(token: String, opId: String, game: String) async throws -> TapReply { calls.append("unrally"); return try tap(opId) {} }
    func finish(token: String, opId: String, game: String) async throws { calls.append("finish"); if let e = finishError { throw e } }
    func unlink(token: String) async throws { calls.append("unlink") }
}

let doublesCfg = GameConfig(mode: "doubles", scoring: "sideout", target: 11, winBy: 2, first: 0, teams: [["Ana", "Ben"], ["Cy", "Di"]])

@MainActor
final class SessionTests: XCTestCase {
    func make(_ api: FakeAPI, token: String? = "w_" + String(repeating: "b", count: 64), ops: [OutboxOp] = []) -> (WatchSession, MemoryTokenStore, MemoryOutboxStore) {
        let tokens = MemoryTokenStore(token), box = MemoryOutboxStore(ops)
        return (WatchSession(api: api, tokens: tokens, outbox: box, base: "https://dinkscore.example", label: "Test watch"), tokens, box)
    }

    func testLinkingShowsAQRThenStoresTheToken() async throws {
        let api = FakeAPI(Rules.newGame(doublesCfg))
        let (s, tokens, _) = make(api, token: nil)
        XCTAssertEqual(s.link, .unlinked)
        await s.tick()                                   // registers, shows the QR
        let p = try XCTUnwrap(s.pairing)
        XCTAssertTrue(p.qrText.hasPrefix("https://dinkscore.example/#watch="))
        XCTAssertEqual(p.confirm4.count, 4)
        XCTAssertEqual(api.calls, ["register"])
        await s.tick()
        XCTAssertEqual(s.link, .unlinked)
        api.linkOnPoll = true
        await s.tick()
        XCTAssertEqual(s.link, .linked)
        XCTAssertEqual(s.clubName, "Test club")
        XCTAssertNotNil(tokens.load())
        XCTAssertNil(s.pairing)
    }

    func testAnExpiredQRIsReplaced() async {
        var clock = Date(timeIntervalSince1970: 1_000_000)
        let api = FakeAPI(Rules.newGame(doublesCfg))
        let s = WatchSession(api: api, tokens: MemoryTokenStore(), outbox: MemoryOutboxStore(), base: "https://x.test", label: "w", now: { clock })
        await s.tick()
        let first = s.pairing?.secrets.pairId
        clock = clock.addingTimeInterval(WatchSession.pairingLifetime + 1)
        await s.tick()                                   // the old one is dropped and a new one registered in the same step
        XCTAssertNotEqual(s.pairing?.secrets.pairId, first)
        XCTAssertEqual(api.calls.filter { $0 == "register" }.count, 2)
    }

    func testScoringShowsAtOnceAndSyncs() async {
        let api = FakeAPI(Rules.newGame(doublesCfg))
        let (s, _, box) = make(api)
        await s.refresh()
        XCTAssertEqual(s.gameId, "live-1")
        XCTAssertEqual(s.game?.score, [0, 0])
        s.score(side: 0)
        XCTAssertEqual(s.game?.score, [1, 0], "shown before the server answers")
        XCTAssertEqual(box.ops.count, 1, "and kept on disk")
        await s.flush()
        XCTAssertEqual(s.model.pending.count, 0)
        XCTAssertEqual(api.server.score, [1, 0])
        XCTAssertEqual(s.game, api.server)
        XCTAssertEqual(box.ops.count, 0)
    }

    func testOfflineTapsAreKeptAndReplayedWithoutDoubleCounting() async {
        let api = FakeAPI(Rules.newGame(doublesCfg))
        let (s, _, box) = make(api)
        await s.refresh()
        api.failNext = [.offline("no network")]
        s.score(side: 0); await s.flush()                 // fails: stays queued
        XCTAssertEqual(s.sync, .offline)
        XCTAssertEqual(box.ops.count, 1)
        s.score(side: 0); s.score(side: 1)
        XCTAssertEqual(s.game?.score, [2, 0], "two points, then a side out")
        let lost = box.ops[1].opId
        api.loseAnswerFor = [lost]                         // the second tap lands but its answer is lost
        await s.flush()
        XCTAssertEqual(s.model.pending.count, 2, "it cannot know the second tap landed")
        await s.flush()                                    // replay: the server sees the id again
        XCTAssertEqual(s.model.pending.count, 0)
        XCTAssertEqual(api.server.score, [2, 0])
        XCTAssertEqual(api.seen.count, 3, "three taps, each counted once")
        XCTAssertEqual(s.game, api.server)
    }

    func testUndoOfAnUnsentPointIsShownAtOnce() async {
        let api = FakeAPI(Rules.newGame(doublesCfg))
        let (s, _, _) = make(api)
        await s.refresh()
        api.failNext = [.offline("x"), .offline("x")]
        s.score(side: 0); await s.flush()
        s.undo()
        XCTAssertEqual(s.game?.score, [0, 0])
        api.failNext = []
        await s.flush()
        XCTAssertEqual(api.server.score, [1, 0], "the fake server's undo does nothing; the point is the queue order was kept")
        XCTAssertEqual(api.calls.suffix(2), ["rally", "unrally"])
    }

    func testARevokedLinkClearsTheTokenAndShowsTheQRAgain() async {
        let api = FakeAPI(Rules.newGame(doublesCfg))
        let (s, tokens, box) = make(api)
        await s.refresh()
        s.score(side: 0)
        api.failNext = [.http(status: 401, message: "revoked")]
        await s.flush()
        XCTAssertEqual(s.link, .unlinked)
        XCTAssertNil(tokens.load())
        XCTAssertEqual(box.ops.count, 0)
        XCTAssertNil(s.game)
    }

    func testAGameThatIsOverOrGoneDropsTheQueue() async {
        let api = FakeAPI(Rules.newGame(doublesCfg))
        let (s, _, box) = make(api)
        await s.refresh()
        s.score(side: 1)
        api.failNext = [.http(status: 409, message: "That game is over.")]
        api.listed = false
        await s.flush()
        XCTAssertEqual(box.ops.count, 0)
        XCTAssertNil(s.gameId, "the refresh after the refusal found no game")
        XCTAssertEqual(s.notice, "That game is over.")
    }

    func testFinishPutsTheGameAwayAndSaysWhenThePhoneMustSave() async {
        var state = Rules.newGame(GameConfig(mode: "singles", scoring: "rally", target: 1, winBy: 1, first: 0, teams: [["A"], ["B"]]))
        state = Rules.rally(state, 0)
        let api = FakeAPI(state)
        let (s, _, _) = make(api)
        await s.refresh()
        XCTAssertEqual(s.game?.winner, 0)
        s.score(side: 1)                                   // over: refused, nothing queued
        XCTAssertEqual(s.model.pending.count, 0)
        api.finishError = .http(status: 400, message: "Unknown action.")
        await s.finish()
        XCTAssertEqual(s.notice, "Save this game on your phone.")
        XCTAssertNil(s.gameId)
        await s.refresh()                                  // the server still lists it
        XCTAssertNil(s.gameId, "a closed game stays closed")
    }

    func testPendingTapsFromAnotherGameAreDropped() async {
        let api = FakeAPI(Rules.newGame(doublesCfg))
        let stale = OutboxOp(kind: .rally, side: 0, game: "live-old")
        let (s, _, box) = make(api, ops: [stale])
        await s.refresh()
        XCTAssertEqual(s.model.pending.count, 0)
        XCTAssertEqual(box.ops.count, 0)
    }

    func testUnlinkTellsTheServerAndForgetsTheToken() async {
        let api = FakeAPI(Rules.newGame(doublesCfg))
        let (s, tokens, _) = make(api)
        await s.unlink()
        XCTAssertTrue(api.calls.contains("unlink"))
        XCTAssertNil(tokens.load())
        XCTAssertEqual(s.link, .unlinked)
    }

    // MARK: one game, no club

    func testAGameCodeLinksTheWatchToOneGame() async throws {
        let api = FakeAPI(Rules.newGame(doublesCfg))
        let (s, tokens, _) = make(api, token: nil)
        await s.join(code: "k7q 2zm", digits: "04 20")
        XCTAssertEqual(api.joined, ["K7Q2ZM 0420"], "tidied before it is sent")
        XCTAssertEqual(s.link, .linked); XCTAssertTrue(s.gameOnly); XCTAssertEqual(s.clubName, "")
        XCTAssertNotNil(tokens.load()); XCTAssertNil(s.notice); XCTAssertNil(s.pairing)
        api.stateLink = "{\"id\":\"g1\",\"label\":null,\"game\":\"live-1\"}"
        await s.refresh()
        XCTAssertEqual(s.gameId, "live-1"); XCTAssertTrue(s.gameOnly)
    }

    func testABadGameCodeIsNotSentAndAWrongOneStaysUnlinked() async throws {
        let api = FakeAPI(Rules.newGame(doublesCfg))
        let (s, tokens, _) = make(api, token: nil)
        await s.join(code: "K7Q", digits: "0420"); XCTAssertNotNil(s.notice)
        await s.join(code: "K7Q2ZM", digits: "42"); XCTAssertNotNil(s.notice)
        await s.join(code: "K7Q2Z1", digits: "0420"); XCTAssertNotNil(s.notice, "1 is not one of the letters and numbers")
        XCTAssertTrue(api.joined.isEmpty, "nothing reached the server")
        api.joinError = .http(status: 403, message: "Those 4 numbers do not match the scoring phone. Check its screen.")
        await s.join(code: "K7Q2ZM", digits: "1111")
        XCTAssertEqual(s.notice, "Those 4 numbers do not match the scoring phone. Check its screen.")
        XCTAssertEqual(s.link, .unlinked); XCTAssertNil(tokens.load()); XCTAssertFalse(s.gameOnly)
        api.joinError = .offline("down")
        await s.join(code: "K7Q2ZM", digits: "1111")
        XCTAssertEqual(s.sync, .offline); XCTAssertEqual(s.link, .unlinked)
    }

    func testWhenTheGameEndsTheLinkEndsAndTheWatchSaysSo() async throws {
        let api = FakeAPI(Rules.newGame(doublesCfg))
        let (s, tokens, _) = make(api, token: nil)
        await s.join(code: "K7Q2ZM", digits: "0420")
        api.failNext = [.http(status: 401, message: "gone")]
        await s.refresh()
        XCTAssertEqual(s.link, .unlinked); XCTAssertNil(tokens.load()); XCTAssertFalse(s.gameOnly)
        XCTAssertEqual(s.notice, "This game's link has ended.")
    }

    func testGameCodesAreTidiedStrictly() {
        XCTAssertEqual(GameCode.clean(" k7q-2zm "), "K7Q2ZM"); XCTAssertEqual(GameCode.clean("K7Q 2ZM"), "K7Q2ZM")
        for bad in ["", "K7Q2Z", "K7Q2ZMA", "K7Q2Z1", "K7Q2Z8", "K7Q2Z!", "ÄBCDEF"] { XCTAssertNil(GameCode.clean(bad), bad) }
        XCTAssertEqual(GameCode.digits("0420"), "0420"); XCTAssertEqual(GameCode.digits("04 20"), "0420")
        for bad in ["", "042", "04200", "04a0", "٠٤٢٠"] { XCTAssertNil(GameCode.digits(bad), bad) }
    }
}
