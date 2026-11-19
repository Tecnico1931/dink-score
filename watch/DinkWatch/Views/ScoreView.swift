import SwiftUI
import WatchKit
import DinkCore

func teamName(_ game: GameState, _ t: Int) -> String { game.cfg.teams[t].joined(separator: " & ") }

/// The call (serving side first, as the phone says it), a big button per team, and undo.
struct ScoreView: View {
    @Environment(AppModel.self) private var app
    let game: GameState

    private var callText: String { game.call.map(String.init).joined(separator: "-") }
    private var serverName: String {
        let team = game.cfg.teams[game.serving]
        return team.indices.contains(game.server) ? team[game.server] : team.first ?? ""
    }

    var body: some View {
        let session = app.session
        VStack(spacing: 4) {
            Text(callText)
                .font(.system(size: 34, weight: .bold, design: .rounded)).monospacedDigit().minimumScaleFactor(0.6).lineLimit(1)
                .accessibilityLabel("Call \(game.call.map(String.init).joined(separator: " "))")
            Text("\(serverName) serving").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            teamButton(0)
            teamButton(1)
        }
        .padding(.horizontal, 2)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { SyncDot(offline: session.sync == .offline, queued: session.model.queued).labelStyle(.iconOnly) }
            ToolbarItem(placement: .bottomBar) {
                Button { session.undo() } label: { Label("Undo", systemImage: "arrow.uturn.backward") }
            }
        }
    }

    private func teamButton(_ t: Int) -> some View {
        Button {
            WKInterfaceDevice.current().play(.click)
            app.session.score(side: t)
        } label: {
            HStack {
                if game.serving == t { Image(systemName: "circle.fill").font(.system(size: 8)).accessibilityHidden(true) }
                Text(teamName(game, t)).font(.footnote).lineLimit(1).minimumScaleFactor(0.7)
                Spacer(minLength: 2)
                Text("\(game.score[t])").font(.title2.bold()).monospacedDigit()
            }
        }
        .buttonStyle(.borderedProminent)
        .tint(t == 0 ? .green : .blue)
        .accessibilityLabel("Point for \(teamName(game, t)). Score \(game.score[t]).")
    }
}
