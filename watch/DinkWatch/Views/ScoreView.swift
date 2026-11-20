import SwiftUI
import WatchKit
import DinkCore

func teamName(_ game: GameState, _ t: Int) -> String { game.cfg.teams[t].joined(separator: " & ") }

/// Matches the phone's floodlit court (dink-score.html, A11Y-START/END): team 1 is always court blue, team 2 court green,
/// ball yellow marks the serving team, and the receiving side dims under the same 30% night veil. Pinned by test/contrast.test.js.
private enum CourtColors {
    static let team0Top = 0x3452EE
    static let team0Bottom = 0x1A2BA6
    static let team1Top = 0x0A7656
    static let team1Bottom = 0x065A43
    static let ball = 0xDDF247
    static let idleVeil = Color(.sRGB, red: 6.0 / 255.0, green: 10.0 / 255.0, blue: 16.0 / 255.0, opacity: 0.30)

    static func srgb(_ hex: Int) -> Color {
        Color(.sRGB, red: Double((hex >> 16) & 0xFF) / 255.0, green: Double((hex >> 8) & 0xFF) / 255.0, blue: Double(hex & 0xFF) / 255.0)
    }

    static func gradient(for team: Int) -> LinearGradient {
        let top = srgb(team == 0 ? team0Top : team1Top)
        let bottom = srgb(team == 0 ? team0Bottom : team1Bottom)
        return LinearGradient(colors: [top, bottom], startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}

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
                if session.gameOnly {
                    Image(systemName: "link").font(.system(size: 14, weight: .semibold)).foregroundStyle(.secondary).frame(width: 34, height: 28)
                        .accessibilityLabel("Linked to this game only")
                } else { Color.clear.frame(width: 34, height: 28) }
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
        let serving = game.serving == t
        let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)
        return Button {
            WKInterfaceDevice.current().play(.click)
            app.session.score(side: t)
        } label: {
            HStack(spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    if serving {
                        Image(systemName: "circle.fill")
                            .font(.system(size: 13))
                            .foregroundStyle(CourtColors.srgb(CourtColors.ball))
                            .accessibilityHidden(true)
                    }
                    Text(teamName(game, t)).font(.system(size: 17, weight: .semibold)).lineLimit(2).minimumScaleFactor(0.6).multilineTextAlignment(.leading)
                }
                Spacer(minLength: 0)
                Text("\(game.score[t])")
                    .font(.system(size: 68, weight: .heavy, design: .rounded)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.5)
            }
            .padding(.horizontal, 8)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background {
                ZStack {
                    shape.fill(CourtColors.gradient(for: t))
                    if !serving { shape.fill(CourtColors.idleVeil) }
                }
            }
            .foregroundStyle(serving ? Color.white : Color.white.opacity(0.9))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Point for \(teamName(game, t)).\(serving ? " Serving." : "") Score \(game.score[t]).")
    }
}
