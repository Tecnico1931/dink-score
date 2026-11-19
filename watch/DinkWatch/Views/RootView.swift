import SwiftUI
import DinkCore

struct RootView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let session = app.session
        Group {
            switch session.link {
            case .unlinked: LinkView()
            case .linked:
                if let game = session.game {
                    if game.isOver { GameOverView(game: game) } else { ScoreView(game: game) }
                } else { IdleView() }
            }
        }
        .onChange(of: app.workoutKey, initial: true) { _, _ in app.syncWorkout() }
    }
}
