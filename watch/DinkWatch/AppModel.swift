import Foundation
import Observation
import WatchKit
import DinkCore

/// Wires the session (link, score, outbox) to the screen's life: polls while the app is in use, keeps going while a workout runs.
@Observable @MainActor
final class AppModel {
    let session: WatchSession
    let workout = WorkoutRecorder()
    @ObservationIgnored private var loop: Task<Void, Never>?

    init() {
        // DINK_BASE_URL is a build setting (project.pbxproj), exposed through Info.plist as DinkBaseURL.
        let base = (Bundle.main.object(forInfoDictionaryKey: "DinkBaseURL") as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "https://dinkscore.vercel.app"
        session = WatchSession(
            api: DinkClient(baseURL: URL(string: base) ?? URL(string: "https://dinkscore.vercel.app")!),
            tokens: KeychainTokenStore(), outbox: FileOutboxStore.standard(),
            base: base, label: WKInterfaceDevice.current().name)
    }

    func scenePhaseChanged(active: Bool) {
        if active { startLoop() } else if !workout.isActive { loop?.cancel(); loop = nil }   // a running workout keeps the app alive, so it keeps syncing
    }

    private func startLoop() {
        guard loop == nil else { return }
        loop = Task { [weak self] in
            while !Task.isCancelled, let self {
                await self.session.tick()
                try? await Task.sleep(for: .seconds(self.session.nextDelay))
            }
        }
    }

    /// What the workout follows: a game is on the wrist and not over. Changes when a game appears, ends, or is closed.
    struct WorkoutKey: Equatable { let game: String?; let live: Bool; let rallies: Int }
    var workoutKey: WorkoutKey {
        guard let id = session.gameId, let g = session.game else { return WorkoutKey(game: nil, live: false, rallies: 0) }
        return WorkoutKey(game: id, live: !g.isOver, rallies: g.rallies)
    }

    func syncWorkout() {
        let k = workoutKey
        if k.live { workout.begin(game: k.game ?? "", rallies: k.rallies) } else { workout.end() }
    }
}
