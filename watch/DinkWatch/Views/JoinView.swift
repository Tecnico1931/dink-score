import SwiftUI
import DinkCore

/// Link to one game with the code its scoring phone shows: 6 characters and 4 numbers. No club, no Home Screen app on the phone.
struct JoinView: View {
    @Environment(AppModel.self) private var app
    let back: () -> Void
    @State private var code = ""
    @State private var digits = ""

    var body: some View {
        let session = app.session
        ScrollView {
            VStack(spacing: 8) {
                Text("Game code").font(.headline)
                Text("On the scoring phone tap Link a watch to this game, then Show a code for the watch to type.").font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                TextField("6 characters", text: $code)
                    .font(.system(.title3, design: .monospaced).weight(.bold)).textInputAutocapitalization(.characters).autocorrectionDisabled()
                    .accessibilityLabel("The 6 characters of the game code")
                TextField("4 numbers", text: $digits)
                    .font(.system(.title3, design: .monospaced).weight(.bold)).autocorrectionDisabled()
                    .accessibilityLabel("The 4 numbers on the scoring phone")
                if let n = session.notice { Text(n).font(.footnote).foregroundStyle(.orange).multilineTextAlignment(.center) }
                Button { Task { await session.join(code: code, digits: digits) } } label: { Text(session.joining ? "Linking" : "Link to this game").frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent).tint(.green).disabled(session.joining)
                Button("Back") { back() }.disabled(session.joining)
            }
        }
    }
}
