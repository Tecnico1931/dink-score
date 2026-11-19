import SwiftUI
import DinkCore

/// Not linked: the QR the phone scans, the 4 numbers it asks for, and the 6 characters to type if the camera is no use.
struct LinkView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let session = app.session
        ScrollView {
            VStack(spacing: 8) {
                if let p = session.pairing {
                    QRView(text: p.qrText)
                        .accessibilityElement()
                        .accessibilityLabel("Link code. Open Dink Score on your phone, choose Link a watch, then type \(p.shortCode) and \(p.confirm4.map(String.init).joined(separator: " ")).")
                    Text(p.confirm4)
                        .font(.system(.title2, design: .monospaced).weight(.bold))
                        .accessibilityLabel("Numbers to type on the phone: \(p.confirm4.map(String.init).joined(separator: " "))")
                    Text("Or type \(p.shortCode)").font(.system(.footnote, design: .monospaced))
                    Text("Dink Score on your phone: Club, Apple Watch, Link a watch.").font(.caption2).foregroundStyle(.secondary).multilineTextAlignment(.center)
                } else {
                    ProgressView("Getting a code")
                }
                if let n = session.notice { Text(n).font(.caption2).foregroundStyle(.orange).multilineTextAlignment(.center) }
                if session.hasLink {
                    Button("Cancel") { session.cancelRelink() }
                }
            }
        }
        .navigationTitle("Link")
    }
}
