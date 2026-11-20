// The answers of the watch routes in api/_watch.js and api/_livecore.js, as the watch reads them.
import Foundation

public struct LinkInfo: Codable, Equatable {
    public let id: String
    public let label: String?
    /// Set when this watch was linked to one game only (no club): the id of that game. A club link has none.
    public let game: String?
    public init(id: String, label: String?, game: String? = nil) { self.id = id; self.label = label; self.game = game }
}

/// A live game a phone sent to this watch, from `watch-state`. The game here leaves out the court sides, so `state.right` is a guess until
/// the first tap answer (which carries the whole state) arrives; scores, serve and the call never depend on it.
public struct WatchGame: Equatable {
    public let id: String
    public let version: Int
    public let state: GameState
}

public struct StateReply: Decodable, Equatable {
    public let clubName: String
    public let link: LinkInfo
    public let game: WatchGame?

    private struct Club: Decodable { let name: String }
    private struct Game: Decodable { let id: String; let version: Int }
    private enum Keys: String, CodingKey { case club, link, game }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        clubName = try c.decode(Club.self, forKey: .club).name
        link = try c.decode(LinkInfo.self, forKey: .link)
        if try c.decodeNil(forKey: .game) { game = nil; return }
        let meta = try c.decode(Game.self, forKey: .game)
        game = WatchGame(id: meta.id, version: meta.version, state: try c.decode(GameState.self, forKey: .game))
    }
}

/// The answer to a tap: the state after it. `duplicate` is a repeated tap id (nothing applied), `unchanged` an undo with nothing to undo,
/// `conflict` a tap that named a version the game has moved past (the watch sends none, so it should not see one).
public struct TapReply: Decodable, Equatable {
    public let state: GameState
    public let version: Int
    public let duplicate: Bool
    public let unchanged: Bool
    public let conflict: Bool

    private enum Keys: String, CodingKey { case state, version, duplicate, unchanged, conflict }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        state = try c.decode(GameState.self, forKey: .state)
        version = try c.decode(Int.self, forKey: .version)
        duplicate = try c.decodeIfPresent(Bool.self, forKey: .duplicate) ?? false
        unchanged = try c.decodeIfPresent(Bool.self, forKey: .unchanged) ?? false
        conflict = try c.decodeIfPresent(Bool.self, forKey: .conflict) ?? false
    }
}

public enum PollReply: Decodable, Equatable {
    case waiting
    case linked(token: String, clubName: String, link: LinkInfo)

    private struct Club: Decodable { let name: String }
    private enum Keys: String, CodingKey { case status, token, club, link }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        guard try c.decode(String.self, forKey: .status) == "linked" else { self = .waiting; return }
        self = .linked(token: try c.decode(String.self, forKey: .token), clubName: try c.decode(Club.self, forKey: .club).name, link: try c.decode(LinkInfo.self, forKey: .link))
    }
}
