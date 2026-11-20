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
        // The score is the hero: the two rows fill the width and everything under the call line. Undo sits left of the call, clear of the clock.
        VStack(spacing: 3) {
            HStack(spacing: 0) {
                Button { session.undo() } label: { Image(systemName: "arrow.uturn.backward").font(.system(size: 16, weight: .semibold)).frame(width: 34, height: 28) }
                    .buttonStyle(.plain).accessibilityLabel("Undo last point")
                Text(callText)
                    .font(.system(size: 26, weight: .bold, design: .rounded)).monospacedDigit().minimumScaleFactor(0.6).lineLimit(1)
                    .frame(maxWidth: .infinity)
                    .accessibilityLabel("Call \(game.call.map(String.init).joined(separator: " ")). \(serverName) serving.")
                Color.clear.frame(width: 34, height: 28)
            }
            teamButton(0)
            teamButton(1)
        }
        .padding(.horizontal, 1)
        .padding(.bottom, 3)
        .ignoresSafeArea(edges: .bottom)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { SyncDot(offline: session.sync == .offline, queued: session.model.queued).labelStyle(.iconOnly) }
        }
    }

    private func teamButton(_ t: Int) -> some View {
        Button {
            WKInterfaceDevice.current().play(.click)
            app.session.score(side: t)
        } label: {
            HStack(spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    if game.serving == t { Image(systemName: "circle.fill").font(.system(size: 13)).accessibilityHidden(true) }
                    Text(teamName(game, t)).font(.system(size: 17, weight: .semibold)).lineLimit(2).minimumScaleFactor(0.6).multilineTextAlignment(.leading)
                }
                Spacer(minLength: 0)
                Text("\(game.score[t])")
                    .font(.system(size: 68, weight: .heavy, design: .rounded)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.5)
            }
            .padding(.horizontal, 8)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(t == 0 ? Color.green : Color.blue))
            .foregroundStyle(.black)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Point for \(teamName(game, t)). Score \(game.score[t]).")
    }
}
