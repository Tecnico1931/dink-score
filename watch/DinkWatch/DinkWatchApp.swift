import SwiftUI

@main
struct DinkWatchApp: App {
    @State private var app = AppModel()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                .onChange(of: phase, initial: true) { _, now in app.scenePhaseChanged(active: now == .active) }
        }
    }
}
