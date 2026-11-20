import SwiftUI
import DinkCore

/// Linked, no game sent to this watch yet.
struct IdleView: View {
    @Environment(AppModel.self) private var app
    @State private var confirmUnlink = false

    var body: some View {
        let session = app.session
        ScrollView {
            VStack(spacing: 8) {
                Image(systemName: "applewatch.watchface").font(.title2).foregroundStyle(.green).accessibilityHidden(true)
                Text(session.gameOnly ? "Linked to one game" : session.clubName.isEmpty ? "Linked" : session.clubName).font(.headline).multilineTextAlignment(.center)
                Text(session.gameOnly ? "That game is not on now. It ends or is saved here, and then this link ends. Enter a new game code to score another." : "Start a game on your phone and send it to this watch.")
                    .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                if let n = session.notice { Text(n).font(.caption2).foregroundStyle(.orange).multilineTextAlignment(.center) }
                SyncDot(offline: session.sync == .offline, queued: session.model.queued)
                Button(session.gameOnly ? "Enter a game code" : "Link another phone") { session.startRelink() }
                Button("Unlink", role: .destructive) { confirmUnlink = true }
            }
        }
        .confirmationDialog("Unlink this watch?", isPresented: $confirmUnlink) {
            Button("Unlink", role: .destructive) { Task { await session.unlink() } }
        }
    }
}

/// Green when everything is sent; orange with the number of taps still waiting when it is not.
struct SyncDot: View {
    let offline: Bool
    let queued: Int
    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(offline || queued > 0 ? Color.orange : Color.green).frame(width: 8, height: 8)
            if offline { Text(queued > 0 ? "Offline, \(queued) kept" : "Offline") } else if queued > 0 { Text("Sending \(queued)") } else { Text("Synced") }
        }
        .font(.caption2).foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
    }
}
