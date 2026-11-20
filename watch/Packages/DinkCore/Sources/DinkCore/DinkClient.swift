// The watch's side of /api/live. Every request is one the tools/watch-sim.mjs script plays against the real handlers.
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum DinkError: Error, Equatable {
    case http(status: Int, message: String)
    case offline(String)         // no answer: no network, a timeout, a dropped connection
    case badAnswer(String)       // an answer that is not what the contract says

    /// What the caller should do about it (report section 3.3).
    public enum Reaction: Equatable { case tokenLost, dropQueue, retry }
    public var reaction: Reaction {
        switch self {
        case .http(let status, _):
            if status == 401 { return .tokenLost }        // revoked, expired or unknown: the phone has to link it again
            if status == 404 || status == 409 { return .dropQueue }  // the game is gone or over
            return .retry                                 // 429, 5xx, anything odd
        case .offline, .badAnswer: return .retry
        }
    }
    public var message: String {
        switch self { case .http(_, let m): m; case .offline(let m): m; case .badAnswer(let m): m }
    }
}

public protocol Transport {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionTransport: Transport {
    private let session: URLSession
    public init(timeout: TimeInterval = 10) {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = timeout
        config.waitsForConnectivity = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData    // we send If-None-Match ourselves and want the real 304
        session = URLSession(configuration: config)
    }
    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw DinkError.badAnswer("Not an HTTP answer.") }
            return (data, http)
        } catch let e as DinkError { throw e } catch { throw DinkError.offline(error.localizedDescription) }
    }
}

public enum StateFetch: Equatable { case unchanged, changed(StateReply, etag: String?) }

public protocol WatchAPI {
    func register(_ p: PairingSecrets, label: String) async throws
    func poll(_ p: PairingSecrets) async throws -> PollReply
    func join(code: String, confirm4: String, label: String) async throws -> PollReply
    func fetchState(token: String, etag: String?) async throws -> StateFetch
    func rally(token: String, opId: String, side: Int, game: String) async throws -> TapReply
    func unrally(token: String, opId: String, game: String) async throws -> TapReply
    func finish(token: String, opId: String, game: String) async throws
    func unlink(token: String) async throws
}

public struct DinkClient: WatchAPI {
    public let baseURL: URL
    private let transport: Transport

    public init(baseURL: URL, transport: Transport = URLSessionTransport()) { self.baseURL = baseURL; self.transport = transport }

    private func request(query: String? = nil, token: String? = nil, body: [String: Any]? = nil, etag: String? = nil) -> URLRequest {
        var url = baseURL.appendingPathComponent("api/live")
        if let query { url = URL(string: url.absoluteString + "?" + query) ?? url }
        var r = URLRequest(url: url)
        if let token { r.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
        if let etag { r.setValue(etag, forHTTPHeaderField: "If-None-Match") }
        if let body {
            r.httpMethod = "POST"
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        return r
    }

    private func run(_ r: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, http) = try await transport.send(r)
        if http.statusCode == 304 || (200..<300).contains(http.statusCode) { return (data, http) }
        let message = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["error"] as? String ?? "The server said \(http.statusCode)."
        throw DinkError.http(status: http.statusCode, message: message)
    }

    private func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do { return try JSONDecoder().decode(type, from: data) } catch { throw DinkError.badAnswer("The server's answer was not understood.") }
    }

    public func register(_ p: PairingSecrets, label: String) async throws {
        _ = try await run(request(body: ["action": "watch-register", "idHash": p.idHash, "pollHash": p.pollHash, "shortHash": p.shortHash, "confirm4": p.confirm4, "label": label]))
    }

    public func poll(_ p: PairingSecrets) async throws -> PollReply {
        try decode(PollReply.self, try await run(request(body: ["action": "watch-poll", "pairId": p.pairId, "pollSecret": p.pollSecret])).0)
    }

    /// `watch-join`: the 6 characters and 4 numbers a scoring phone shows for its game; the answer is a link to that one game, token included.
    public func join(code: String, confirm4: String, label: String) async throws -> PollReply {
        try decode(PollReply.self, try await run(request(body: ["action": "watch-join", "code": code, "confirm4": confirm4, "label": label])).0)
    }

    public func fetchState(token: String, etag: String?) async throws -> StateFetch {
        let (data, http) = try await run(request(query: "watch=state", token: token, etag: etag))
        if http.statusCode == 304 { return .unchanged }
        return .changed(try decode(StateReply.self, data), etag: http.value(forHTTPHeaderField: "ETag"))
    }

    public func rally(token: String, opId: String, side: Int, game: String) async throws -> TapReply {
        try decode(TapReply.self, try await run(request(token: token, body: ["action": "watch-rally", "opId": opId, "side": side, "game": game])).0)
    }

    public func unrally(token: String, opId: String, game: String) async throws -> TapReply {
        try decode(TapReply.self, try await run(request(token: token, body: ["action": "watch-unrally", "opId": opId, "game": game])).0)
    }

    /// Stage 2's `watch-finish {opId}`: the server saves the finished game. Until that is deployed the server answers 400 ("Unknown action").
    public func finish(token: String, opId: String, game: String) async throws {
        _ = try await run(request(token: token, body: ["action": "watch-finish", "opId": opId, "game": game]))
    }

    public func unlink(token: String) async throws {
        _ = try await run(request(token: token, body: ["action": "watch-unlink"]))
    }
}
