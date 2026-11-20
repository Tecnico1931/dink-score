// The one object the screens read: is the watch linked, what is the QR, what is the score, is everything synced.
// It does one step per `tick()` (the app calls it in a loop and sleeps `nextDelay` between), so a test can drive it step by step.
import Foundation
import Observation

@Observable @MainActor
public final class WatchSession {
    public enum Link: Equatable { case unlinked, linked }
    public enum Sync: Equatable { case ok, offline }
    public struct Pairing: Equatable {
        public let secrets: PairingSecrets
        public let qrText: String
        public let expiresAt: Date
        public var shortCode: String { Hashes.spaced(secrets.shortCode) }
        public var confirm4: String { secrets.confirm4 }
    }

    public private(set) var link: Link
    public private(set) var pairing: Pairing?
    public private(set) var clubName = ""
    /// This watch holds a link to one game only (no club): true until it is unlinked. Known from the link made or the last answer.
    public private(set) var gameOnly = false
    /// A game code is being checked.
    public private(set) var joining = false
    public private(set) var model: ScoreModel
    public private(set) var sync: Sync = .ok
    /// A short sentence for the screen ("No connection", "Saved"); cleared by the next good answer.
    public private(set) var notice: String?

    @ObservationIgnored private let api: WatchAPI
    @ObservationIgnored private let tokens: TokenStore
    @ObservationIgnored private let outbox: OutboxStore
    @ObservationIgnored private let base: String
    @ObservationIgnored private let label: String
    @ObservationIgnored private let now: () -> Date
    @ObservationIgnored private let random: (Int) -> [UInt8]
    @ObservationIgnored private var etag: String?
    @ObservationIgnored private var failures = 0
    @ObservationIgnored private var flushing = false
    @ObservationIgnored private var putAway: String?      // a finished game the player has closed: ignore it if the server still lists it
    @ObservationIgnored private var holdUntil: Date?      // the server asked us to slow down

    public static let pairingLifetime: TimeInterval = 270  // the server keeps a QR for 5 minutes (PAIR_TTL_MIN)

    public init(api: WatchAPI, tokens: TokenStore, outbox: OutboxStore, base: String, label: String,
                now: @escaping () -> Date = Date.init, random: @escaping (Int) -> [UInt8] = SecureRandom.bytes) {
        self.api = api; self.tokens = tokens; self.outbox = outbox; self.base = base; self.label = label; self.now = now; self.random = random
        let linked = tokens.load() != nil
        link = linked ? .linked : .unlinked
        model = ScoreModel(pending: linked ? outbox.load() : [])
    }

    /// A watch that is already linked can go back to the QR (to link another phone) and cancel.
    public var hasLink: Bool { tokens.load() != nil }

    /// The game to show, or nil (none sent to this watch, or the player closed it).
    public var game: GameState? { model.gameId == nil ? nil : model.display }
    public var gameId: String? { model.gameId }

    /// How long the app should wait before the next `tick()`.
    public var nextDelay: TimeInterval {
        if let hold = holdUntil, hold > now() { return hold.timeIntervalSince(now()) }
        if link == .unlinked { return 2 }
        return failures == 0 ? 3 : min(30, 3 * pow(2, Double(min(failures, 4))))
    }

    public func tick() async {
        if let hold = holdUntil, hold > now() { return }
        switch link {
        case .unlinked: await pairingStep()
        case .linked: if model.pending.isEmpty { await refresh() } else { await flush() }
        }
    }

    // MARK: linking

    /// Clear the line of text under the buttons (the screen changes, so an old error should not follow it).
    public func clearNotice() { notice = nil }

    /// Throw the QR away and show a new one (the "Link another phone" button).
    public func showNewCode() { pairing = nil; holdUntil = nil }

    /// "Link another phone" on a linked watch: back to the QR; the old link stays until the new one is collected.
    public func startRelink() { link = .unlinked; pairing = nil; holdUntil = nil }
    public func cancelRelink() { if tokens.load() != nil { link = .linked; pairing = nil } }

    private func pairingStep() async {
        if let p = pairing, now() >= p.expiresAt { pairing = nil }
        guard let p = pairing else { await newPairing(); return }
        do {
            switch try await api.poll(p.secrets) {
            case .waiting: break
            case .linked(let token, let club, let info): adopt(token: token, club: club, info: info)
            }
            sync = .ok
        } catch let e as DinkError {
            switch e {
            case .http(let status, let message):
                if status == 404 || status == 403 { pairing = nil }          // expired or not ours: make a new one
                else { notice = message; hold(60) }
            default: sync = .offline; notice = "No connection."
            }
        } catch { sync = .offline }
    }

    /// A link was made (the phone claimed the QR, or the game code was accepted): keep the token and start clean.
    private func adopt(token: String, club: String, info: LinkInfo) {
        tokens.save(token); clubName = club; gameOnly = info.game != nil
        link = .linked; pairing = nil; etag = nil; failures = 0; notice = nil
        model = ScoreModel()
        outbox.save([])
    }

    /// Link to one game with the code its scoring phone shows (no club, no Home Screen app). The server checks the 4 numbers and ends the code after 3 wrong tries.
    public func join(code: String, digits: String) async {
        guard !joining else { return }
        guard let short = GameCode.clean(code) else { notice = "Type the 6 characters shown on the scoring phone."; return }
        guard let four = GameCode.digits(digits) else { notice = "Type the 4 numbers shown on the scoring phone."; return }
        joining = true; defer { joining = false }
        do {
            switch try await api.join(code: short, confirm4: four, label: label) {
            case .linked(let token, let club, let info): adopt(token: token, club: club, info: info); sync = .ok
            case .waiting: notice = "That code did not work. Check the scoring phone."
            }
        } catch let e as DinkError {
            if case .http(_, let message) = e { notice = message } else { sync = .offline; notice = "No connection. Try again." }
        } catch { sync = .offline; notice = "No connection. Try again." }
    }

    private var lostMessage: String { gameOnly ? "This game's link has ended." : "This watch is not linked any more. Link it again from the phone." }

    private func newPairing() async {
        let secrets = PairingSecrets.make(random: random)
        do {
            try await api.register(secrets, label: label)
            pairing = Pairing(secrets: secrets, qrText: secrets.qrText(base: base), expiresAt: now().addingTimeInterval(Self.pairingLifetime))
            sync = .ok; notice = nil
        } catch let e as DinkError {
            if case .http(_, let message) = e { notice = message; hold(120) } else { sync = .offline; notice = "No connection." }
        } catch { sync = .offline }
    }

    private func hold(_ seconds: TimeInterval) { holdUntil = now().addingTimeInterval(seconds) }

    // MARK: scoring

    public func score(side: Int) {
        guard model.score(side: side, opId: newOpId(), at: now()) != nil else { return }
        outbox.save(model.pending)
        Task { await flush() }
    }

    public func undo() {
        guard model.undo(opId: newOpId(), at: now()) != nil else { return }
        outbox.save(model.pending)
        Task { await flush() }
    }

    private func newOpId() -> String { UUID().uuidString }

    /// Send the outbox in order. One run at a time; taps made meanwhile are picked up by the run in progress.
    public func flush() async {
        guard !flushing else { return }
        flushing = true; defer { flushing = false }
        guard let token = tokens.load() else { becomeUnlinked(lostMessage); return }
        while let op = model.pending.first {
            do {
                let reply = op.kind == .rally
                    ? try await api.rally(token: token, opId: op.opId, side: op.side ?? 0, game: op.game)
                    : try await api.unrally(token: token, opId: op.opId, game: op.game)
                if reply.conflict { model.adopt(game: op.game, state: reply.state, version: reply.version); failures += 1; return }
                model.ack(op.opId)
                model.adopt(game: op.game, state: reply.state, version: reply.version)
                outbox.save(model.pending)
                succeeded()
            } catch let e as DinkError {
                switch e.reaction {
                case .tokenLost: becomeUnlinked(lostMessage); return
                case .dropQueue:
                    model.dropPending(); outbox.save([]); etag = nil
                    failures = 0
                    await refresh(); notice = e.message; return
                case .retry: failed(e); return
                }
            } catch { failed(.offline(error.localizedDescription)); return }
        }
    }

    /// Ask the server what game, if any, was sent to this watch.
    public func refresh() async {
        guard let token = tokens.load() else { becomeUnlinked(lostMessage); return }
        do {
            switch try await api.fetchState(token: token, etag: etag) {
            case .unchanged: break
            case .changed(let reply, let tag):
                etag = tag; clubName = reply.clubName; gameOnly = reply.link.game != nil
                if let g = reply.game, g.id != putAway { model.adopt(game: g.id, state: g.state, version: g.version) }
                else { model.clearGame(); if reply.game == nil { putAway = nil } }
                outbox.save(model.pending)
            }
            succeeded()
        } catch let e as DinkError {
            if e.reaction == .tokenLost { becomeUnlinked(lostMessage) } else { failed(e) }
        } catch { failed(.offline(error.localizedDescription)) }
    }

    private func succeeded() { failures = 0; sync = .ok; notice = nil }
    private func failed(_ e: DinkError) {
        failures += 1; sync = .offline
        if case .http(_, let message) = e { notice = message } else { notice = "No connection. Points are kept and will be sent." }
    }

    // MARK: finishing and leaving

    /// Game over: ask the server to save the game (stage 2's `watch-finish`). Until that exists the answer is a 400 and the phone saves it.
    public func finish() async {
        guard let id = model.gameId, let token = tokens.load() else { return }
        await flush()
        do {
            try await api.finish(token: token, opId: newOpId(), game: id)
            notice = "Saved."; close(id)
        } catch let e as DinkError {
            switch e {
            case .http(404, _): notice = "Already saved."; close(id)
            case .http(401, _): becomeUnlinked(lostMessage)
            case .http(400, _): notice = "Save this game on your phone."; close(id)
            default: failed(e)
            }
        } catch { failed(.offline(error.localizedDescription)) }
    }

    /// Close a finished game without saving it from the watch.
    public func done() { if let id = model.gameId { close(id) } }

    private func close(_ id: String) { putAway = id; model.clearGame(); outbox.save([]) }

    public func unlink() async {
        if let token = tokens.load() { try? await api.unlink(token: token) }
        becomeUnlinked(nil)
    }

    private func becomeUnlinked(_ message: String?) {
        tokens.clear(); outbox.save([])
        model = ScoreModel(); link = .unlinked; pairing = nil; etag = nil; putAway = nil; failures = 0; clubName = ""; gameOnly = false
        notice = message
    }
}
