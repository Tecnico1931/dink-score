import Foundation
import HealthKit
import Observation

/// Records the game as a pickleball workout: it starts when a game is on the wrist, saves to Health when the game ends or is left, and
/// keeps the app frontmost while the game goes on. Nothing from it is sent to the Dink back end.
/// If Health access is refused the game is scored all the same, just without a workout.
@Observable @MainActor
final class WorkoutRecorder: NSObject {
    private(set) var isActive = false
    private(set) var unavailable = false      // no Health on this device, or the player said no

    @ObservationIgnored private let store = HKHealthStore()
    @ObservationIgnored private var session: HKWorkoutSession?
    @ObservationIgnored private var builder: HKLiveWorkoutBuilder?
    @ObservationIgnored private var wanted = false
    @ObservationIgnored private var starting = false
    @ObservationIgnored private var game = ""
    @ObservationIgnored private var scored = false     // a point was played: a workout with none is dropped, not saved

    /// A game is being played: start (once per game).
    func begin(game id: String, rallies: Int) {
        wanted = true
        if isActive && game != id { end(); wanted = true }   // a different game: close this workout, start another
        game = id
        if rallies > 0 { scored = true }
        guard !isActive, !starting, !unavailable else { return }
        starting = true
        Task { await start() }
    }

    /// The game is over or was left: finish and save it to Health (unless nobody scored).
    func end() {
        wanted = false
        guard let session, let builder else { scored = false; return }
        let save = scored
        scored = false
        self.session = nil; self.builder = nil
        session.end()
        Task {
            do {
                try await builder.endCollection(at: Date())
                if save { _ = try await builder.finishWorkout() } else { builder.discardWorkout() }
            } catch { builder.discardWorkout() }
            isActive = false
        }
    }

    private func start() async {
        defer { starting = false }
        guard HKHealthStore.isHealthDataAvailable() else { unavailable = true; return }
        let types: Set<HKSampleType> = [HKQuantityType(.heartRate), HKQuantityType(.activeEnergyBurned)]
        do { try await store.requestAuthorization(toShare: [HKObjectType.workoutType()], read: types) }   // asks once; the system remembers the answer
        catch { unavailable = true; return }
        guard store.authorizationStatus(for: HKObjectType.workoutType()) == .sharingAuthorized else { unavailable = true; return }
        guard wanted else { return }                       // the game ended while the permission sheet was up
        let config = HKWorkoutConfiguration()
        config.activityType = .pickleball
        config.locationType = .unknown
        do {
            let session = try HKWorkoutSession(healthStore: store, configuration: config)
            let builder = session.associatedWorkoutBuilder()
            builder.dataSource = HKLiveWorkoutDataSource(healthStore: store, workoutConfiguration: config)
            session.delegate = self
            let now = Date()
            self.session = session; self.builder = builder
            isActive = true
            session.startActivity(with: now)
            try await builder.beginCollection(at: now)
            if !wanted { end() }
        } catch {
            session = nil; builder = nil; isActive = false
        }
    }
}

extension WorkoutRecorder: HKWorkoutSessionDelegate {
    nonisolated func workoutSession(_ workoutSession: HKWorkoutSession, didChangeTo toState: HKWorkoutSessionState, from fromState: HKWorkoutSessionState, date: Date) {}
    nonisolated func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: Error) {
        Task { @MainActor in
            if self.session === workoutSession { self.session = nil; self.builder = nil; self.isActive = false }
        }
    }
}
