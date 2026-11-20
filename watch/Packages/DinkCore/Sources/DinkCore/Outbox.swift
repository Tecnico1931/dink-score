// The watch keeps scoring when a request fails: every tap becomes an operation with its own id, kept on disk until the server has
// answered it. A retry after a lost answer carries the same id, and the server counts that tap once (applyRally's `opId`).
import Foundation

public struct OutboxOp: Codable, Equatable {
    public enum Kind: String, Codable { case rally, unrally }
    public let opId: String      // /^[A-Za-z0-9_-]{8,64}$/ on the server; a UUID fits
    public let kind: Kind
    public let side: Int?        // rally only: the team that won the point
    public let game: String
    public let at: Date

    public init(opId: String = UUID().uuidString, kind: Kind, side: Int? = nil, game: String, at: Date = Date()) {
        self.opId = opId; self.kind = kind; self.side = side; self.game = game; self.at = at
    }
}

public protocol OutboxStore: AnyObject {
    func load() -> [OutboxOp]
    func save(_ ops: [OutboxOp])
}

public final class MemoryOutboxStore: OutboxStore {
    public var ops: [OutboxOp]
    public init(_ ops: [OutboxOp] = []) { self.ops = ops }
    public func load() -> [OutboxOp] { ops }
    public func save(_ ops: [OutboxOp]) { self.ops = ops }
}

/// A JSON file in Application Support, written atomically.
public final class FileOutboxStore: OutboxStore {
    private let url: URL
    public init(url: URL) { self.url = url }
    public static func standard(name: String = "outbox.json") -> FileOutboxStore {
        let dir = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)) ?? FileManager.default.temporaryDirectory
        return FileOutboxStore(url: dir.appendingPathComponent(name))
    }
    public func load() -> [OutboxOp] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([OutboxOp].self, from: data)) ?? []
    }
    public func save(_ ops: [OutboxOp]) {
        if ops.isEmpty { try? FileManager.default.removeItem(at: url); return }
        if let data = try? JSONEncoder().encode(ops) { try? data.write(to: url, options: .atomic) }
    }
}

/// What the watch shows: the last state the server confirmed with the taps it has not answered yet applied on top, using the same rules.
/// Undo only shows at once for points still waiting in the outbox; undoing a point the server already holds waits for the answer.
public struct ScoreModel: Equatable {
    public private(set) var gameId: String?
    public private(set) var confirmed: GameState?
    public private(set) var version = 0
    public private(set) var pending: [OutboxOp]

    public init(pending: [OutboxOp] = []) { self.pending = pending }

    public var display: GameState? {
        guard var s = confirmed else { return nil }
        var stack: [GameState] = []
        for op in pending where op.game == gameId {
            switch op.kind {
            case .rally: stack.append(s); s = Rules.rally(s, op.side ?? 0)
            case .unrally: if let prev = stack.popLast() { s = prev }
            }
        }
        return s
    }
    /// Taps the server has not confirmed.
    public var queued: Int { pending.count }

    /// The server's word about a game: its state replaces ours, and taps for any other game are dropped.
    public mutating func adopt(game: String, state: GameState, version: Int) {
        gameId = game; confirmed = state; self.version = version
        pending.removeAll { $0.game != game }
    }
    public mutating func clearGame() { gameId = nil; confirmed = nil; version = 0; pending = [] }
    public mutating func dropPending() { pending = [] }

    /// A point for `side`. Nil when there is no game or it is over (the server would refuse it).
    public mutating func score(side: Int, opId: String = UUID().uuidString, at: Date = Date()) -> OutboxOp? {
        guard let id = gameId, let d = display, !d.isOver, side == 0 || side == 1 else { return nil }
        let op = OutboxOp(opId: opId, kind: .rally, side: side, game: id, at: at)
        pending.append(op); return op
    }
    public mutating func undo(opId: String = UUID().uuidString, at: Date = Date()) -> OutboxOp? {
        guard let id = gameId, confirmed != nil else { return nil }
        let op = OutboxOp(opId: opId, kind: .unrally, game: id, at: at)
        pending.append(op); return op
    }
    public mutating func ack(_ opId: String) { pending.removeAll { $0.opId == opId } }
}
