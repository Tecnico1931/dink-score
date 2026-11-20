// The scoring rules, ported from `PB` in dink-score.html (the same code as api/_pb.js). Three copies now: the golden vectors in
// Tests/DinkCoreTests/Fixtures (made by tools/pb-vectors.mjs from api/_pb.js) fail `swift test` if this one drifts.
import Foundation

public struct GameConfig: Codable, Equatable {
    public var mode: String        // "singles" | "doubles"
    public var scoring: String     // "sideout" | "rally"
    public var target: Int
    public var winBy: Int
    public var first: Int?
    public var teams: [[String]]

    public init(mode: String, scoring: String, target: Int, winBy: Int, first: Int? = nil, teams: [[String]]) {
        self.mode = mode; self.scoring = scoring; self.target = target; self.winBy = winBy; self.first = first; self.teams = teams
    }
    public var isDoubles: Bool { mode == "doubles" }
}

public struct GameState: Codable, Equatable {
    public var cfg: GameConfig
    public var score: [Int]
    public var serving: Int
    public var serverNum: Int
    public var right: [Int]        // index of the player standing in the right-hand court, per team
    public var server: Int         // index of the serving player within the serving team
    public var rallies: Int
    public var switched: Bool
    public var justSwitched: Bool
    public var winner: Int?

    public init(cfg: GameConfig, score: [Int], serving: Int, serverNum: Int, right: [Int] = [0, 0], server: Int = 0, rallies: Int = 0,
                switched: Bool = false, justSwitched: Bool = false, winner: Int? = nil) {
        self.cfg = cfg; self.score = score; self.serving = serving; self.serverNum = serverNum; self.right = right; self.server = server
        self.rallies = rallies; self.switched = switched; self.justSwitched = justSwitched; self.winner = winner
    }

    // The server's answer to a tap carries the whole state; the game in `watch-state` leaves out the court sides, so those may be missing.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        cfg = try c.decode(GameConfig.self, forKey: .cfg)
        score = try c.decode([Int].self, forKey: .score)
        serving = try c.decode(Int.self, forKey: .serving)
        serverNum = try c.decodeIfPresent(Int.self, forKey: .serverNum) ?? 1
        right = try c.decodeIfPresent([Int].self, forKey: .right) ?? [0, 0]
        server = try c.decodeIfPresent(Int.self, forKey: .server) ?? 0
        rallies = try c.decodeIfPresent(Int.self, forKey: .rallies) ?? 0
        winner = try c.decodeIfPresent(Int.self, forKey: .winner)
        justSwitched = try c.decodeIfPresent(Bool.self, forKey: .justSwitched) ?? false
        switched = try c.decodeIfPresent(Bool.self, forKey: .switched) ?? ((score.max() ?? 0) >= Rules.switchAt(cfg.target))
    }
    private enum Keys: String, CodingKey { case cfg, score, serving, serverNum, right, server, rallies, switched, justSwitched, winner }

    public var isOver: Bool { winner != nil }
    /// The score call, serving side first: [serving score, other score] and, for side-out doubles, the server number.
    public var call: [Int] { Rules.call(self) }
}

public enum Rules {
    public static func newGame(_ cfg: GameConfig) -> GameState {
        GameState(cfg: cfg, score: [0, 0], serving: cfg.first ?? 0, serverNum: cfg.isDoubles && cfg.scoring == "sideout" ? 2 : 1)
    }

    public static func switchAt(_ target: Int) -> Int { (target + 1) / 2 }

    /// Team `w` (0 or 1) won the rally.
    public static func rally(_ prev: GameState, _ w: Int) -> GameState {
        var s = prev
        s.justSwitched = false
        if s.winner != nil { return s }
        let doubles = s.cfg.isDoubles
        s.rallies += 1
        if s.cfg.scoring == "rally" {
            s.score[w] += 1
            if w == s.serving { if doubles { s.right[w] = 1 - s.right[w] } }
            else { s.serving = w; s.server = doubles ? s.right[w] : 0 }
        } else if w == s.serving {
            s.score[w] += 1
            if doubles { s.right[w] = 1 - s.right[w] }   // server moves to the other side and serves again
        } else if doubles && s.serverNum == 1 {
            s.serverNum = 2; s.server = 1 - s.server       // partner serves from where they stand
        } else {
            s.serving = 1 - s.serving; s.serverNum = 1
            s.server = doubles ? s.right[s.serving] : 0    // side out: player on the right serves first
        }
        if !s.switched && (s.score.max() ?? 0) >= switchAt(s.cfg.target) { s.switched = true; s.justSwitched = true }
        for t in 0...1 where s.score[t] >= s.cfg.target && s.score[t] - s.score[1 - t] >= s.cfg.winBy { s.winner = t }
        return s
    }

    public static func call(_ s: GameState) -> [Int] {
        let a = s.score[s.serving], b = s.score[1 - s.serving]
        if s.cfg.isDoubles && s.cfg.scoring == "sideout" { return [a, b, s.serverNum] }
        return [a, b]
    }
}
