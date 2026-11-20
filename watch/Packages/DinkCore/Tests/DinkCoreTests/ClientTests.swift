// The client's requests and how it reads answers, against a canned transport.
import XCTest
@testable import DinkCore

final class CannedTransport: Transport, @unchecked Sendable {
    var requests: [URLRequest] = []
    var status = 200
    var body = "{}"
    var headers: [String: String] = [:]
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!)
    }
}

final class ClientTests: XCTestCase {
    func make(_ t: CannedTransport) -> DinkClient { DinkClient(baseURL: URL(string: "https://dink.example")!, transport: t) }
    func json(_ r: URLRequest) -> [String: Any] { (try? JSONSerialization.jsonObject(with: r.httpBody ?? Data())) as? [String: Any] ?? [:] }

    func testRegisterSendsOnlyHashes() async throws {
        let t = CannedTransport()
        let p = PairingSecrets(pairId: "0123456789abcdef0123456789abcdef", pollSecret: "fedcba9876543210fedcba9876543210", confirm4: "4821")
        try await make(t).register(p, label: "Ana's Watch")
        let r = t.requests[0], b = json(r)
        XCTAssertEqual(r.url?.absoluteString, "https://dink.example/api/live")
        XCTAssertEqual(r.httpMethod, "POST")
        XCTAssertNil(r.value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(b["action"] as? String, "watch-register")
        XCTAssertEqual(b["idHash"] as? String, p.idHash)
        XCTAssertEqual(b["confirm4"] as? String, "4821")
        XCTAssertNil(b["pairId"]); XCTAssertNil(b["pollSecret"])
        XCTAssertFalse(String(decoding: r.httpBody!, as: UTF8.self).contains(p.pairId))
    }

    func testPollReadsTheTokenOnce() async throws {
        let t = CannedTransport()
        t.body = "{\"ok\":true,\"status\":\"linked\",\"token\":\"w_abc\",\"link\":{\"id\":\"L1\",\"label\":\"W\"},\"club\":{\"name\":\"Club\"}}"
        let p = PairingSecrets.make()
        let r = try await make(t).poll(p)
        XCTAssertEqual(r, .linked(token: "w_abc", clubName: "Club", link: LinkInfo(id: "L1", label: "W")))
        XCTAssertEqual(json(t.requests[0])["pairId"] as? String, p.pairId)
        t.body = "{\"ok\":true,\"status\":\"waiting\"}"
        let w = try await make(t).poll(p)
        XCTAssertEqual(w, .waiting)
    }

    func testJoinSendsTheTypedCodeAndReadsAGameLink() async throws {
        let t = CannedTransport()
        t.body = "{\"ok\":true,\"status\":\"linked\",\"token\":\"w_abc\",\"link\":{\"id\":\"L1\",\"label\":\"W\",\"game\":\"live-9\"},\"club\":{\"name\":\"\"}}"
        let r = try await make(t).join(code: "K7Q2ZM", confirm4: "0420", label: "W")
        XCTAssertEqual(r, .linked(token: "w_abc", clubName: "", link: LinkInfo(id: "L1", label: "W", game: "live-9")))
        let b = json(t.requests[0])
        XCTAssertEqual(b["action"] as? String, "watch-join"); XCTAssertEqual(b["code"] as? String, "K7Q2ZM"); XCTAssertEqual(b["confirm4"] as? String, "0420")
        XCTAssertNil(t.requests[0].value(forHTTPHeaderField: "Authorization"), "no token yet")
        t.status = 403; t.body = "{\"error\":\"Those 4 numbers do not match the scoring phone.\"}"
        do { _ = try await make(t).join(code: "K7Q2ZM", confirm4: "1111", label: "W"); XCTFail() } catch let e as DinkError { XCTAssertEqual(e.message, "Those 4 numbers do not match the scoring phone.") }
    }

    func testStateUsesTheTokenAndTheETag() async throws {
        let t = CannedTransport()
        t.body = "{\"club\":{\"name\":\"C\"},\"link\":{\"id\":\"L\",\"label\":null},\"game\":null}"
        t.headers = ["ETag": "\"abc\""]
        let c = make(t)
        let first = try await c.fetchState(token: "w_t", etag: nil)
        guard case .changed(let reply, let tag) = first else { return XCTFail() }
        XCTAssertNil(reply.game); XCTAssertEqual(tag, "\"abc\"")
        XCTAssertEqual(t.requests[0].url?.absoluteString, "https://dink.example/api/live?watch=state")
        XCTAssertEqual(t.requests[0].value(forHTTPHeaderField: "Authorization"), "Bearer w_t")
        t.status = 304; t.body = ""
        let second = try await c.fetchState(token: "w_t", etag: "\"abc\"")
        XCTAssertEqual(second, .unchanged)
        XCTAssertEqual(t.requests[1].value(forHTTPHeaderField: "If-None-Match"), "\"abc\"")
    }

    func testTheGameInWatchStateBecomesAState() throws {
        let body = """
        {"club":{"name":"C"},"link":{"id":"L","label":null},"game":{"id":"g1","teams":[["A","B"],["C","D"]],"cfg":{"mode":"doubles","scoring":"sideout","target":11,"winBy":2,"teams":[["A","B"],["C","D"]]},"score":[6,3],"serving":1,"server":1,"serverNum":2,"winner":null,"rallies":9,"version":4,"call":[3,6,2],"say":"Score: 3, 6, 2"}}
        """
        let g = try XCTUnwrap(JSONDecoder().decode(StateReply.self, from: Data(body.utf8)).game)
        XCTAssertEqual(g.id, "g1"); XCTAssertEqual(g.version, 4)
        XCTAssertEqual(g.state.score, [6, 3]); XCTAssertEqual(g.state.call, [3, 6, 2])
        XCTAssertTrue(g.state.switched, "6 is past the changeover at 6 of 11")
        XCTAssertNil(g.state.winner)
    }

    func testTapsCarryTheirIdAndGame() async throws {
        let t = CannedTransport()
        t.body = "{\"ok\":true,\"state\":{\"cfg\":{\"mode\":\"singles\",\"scoring\":\"rally\",\"target\":11,\"winBy\":2,\"teams\":[[\"A\"],[\"B\"]]},\"score\":[1,0],\"serving\":0,\"serverNum\":1,\"right\":[0,0],\"server\":0,\"rallies\":1,\"switched\":false,\"justSwitched\":false,\"winner\":null,\"startedAt\":5,\"endedAt\":null},\"version\":7,\"duplicate\":true}"
        let reply = try await make(t).rally(token: "w_t", opId: "op-12345678", side: 1, game: "g1")
        XCTAssertTrue(reply.duplicate); XCTAssertEqual(reply.version, 7); XCTAssertEqual(reply.state.score, [1, 0])
        let b = json(t.requests[0])
        XCTAssertEqual(b["action"] as? String, "watch-rally")
        XCTAssertEqual(b["opId"] as? String, "op-12345678")
        XCTAssertEqual(b["side"] as? Int, 1)
        XCTAssertEqual(b["game"] as? String, "g1")
        XCTAssertNil(b["base"], "a watch sends no base: the server retries it against fresh state")
    }

    func testErrorsCarryTheServersWordsAndTheRightReaction() async {
        let t = CannedTransport()
        t.status = 401; t.body = "{\"error\":\"This watch is not linked any more.\"}"
        do { _ = try await make(t).fetchState(token: "w_t", etag: nil); XCTFail() }
        catch let e as DinkError { XCTAssertEqual(e, .http(status: 401, message: "This watch is not linked any more.")); XCTAssertEqual(e.reaction, .tokenLost) }
        catch { XCTFail() }
        XCTAssertEqual(DinkError.http(status: 409, message: "").reaction, .dropQueue)
        XCTAssertEqual(DinkError.http(status: 404, message: "").reaction, .dropQueue)
        XCTAssertEqual(DinkError.http(status: 429, message: "").reaction, .retry)
        XCTAssertEqual(DinkError.http(status: 503, message: "").reaction, .retry)
        XCTAssertEqual(DinkError.offline("x").reaction, .retry)
    }
}
