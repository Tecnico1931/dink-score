import SwiftUI
import WatchKit
import DinkCore

/// The game is over: who won, the score, Finish (the server saves it) and Undo for a mis-tapped last point.
struct GameOverView: View {
    @Environment(AppModel.self) private var app
    let game: GameState
    @State private var busy = false

    var body: some View {
        let session = app.session, w = game.winner ?? 0
        ScrollView {
            VStack(spacing: 6) {
                Text("Game over").font(.caption).foregroundStyle(.secondary)
                Text(teamName(game, w)).font(.headline).multilineTextAlignment(.center)
                Text("\(game.score[w]) - \(game.score[1 - w])").font(.system(size: 34, weight: .bold, design: .rounded)).monospacedDigit()
                if let n = session.notice { Text(n).font(.caption2).foregroundStyle(.orange).multilineTextAlignment(.center) }
                Button { busy = true; Task { await session.finish(); busy = false } } label: { Text(busy ? "Saving" : "Finish").frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent).tint(.green).disabled(busy)
                Button("Undo last point") { session.undo() }.disabled(busy)
                Button("Close without saving") { session.done() }.font(.footnote).disabled(busy)
            }
        }
        .onAppear { WKInterfaceDevice.current().play(.success) }
    }
}
