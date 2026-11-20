import SwiftUI
import DinkCore

/// Not linked: the QR the phone scans, the 4 numbers it asks for, and the 6 characters to type if the camera is no use.
struct LinkView: View {
    @Environment(AppModel.self) private var app
    @State private var entering = false

    var body: some View {
        if entering { JoinView(back: { entering = false }) } else { qrScreen }
    }

    @ViewBuilder private var qrScreen: some View {
        let session = app.session
        // The QR is the largest square that fits the screen below the clock, edge to edge; the numbers are one scroll (or Digital Crown turn) below it.
        GeometryReader { geo in
            let side = min(geo.size.width, geo.size.height)
            ScrollView {
                VStack(spacing: 6) {
                    if let p = session.pairing {
                        QRView(text: p.qrText)
                            .frame(width: side, height: side)
                            .accessibilityElement()
                            .accessibilityLabel("Link code. Open Dink Score on your phone, choose Link a watch, then type \(p.shortCode) and \(p.confirm4.map(String.init).joined(separator: " ")).")
                        Text(p.confirm4)
                            .font(.system(.title2, design: .monospaced).weight(.bold))
                            .accessibilityLabel("Numbers to type on the phone: \(p.confirm4.map(String.init).joined(separator: " "))")
                        Text("Or type \(p.shortCode)").font(.system(.footnote, design: .monospaced))
                        Text("Dink Score on your phone: Club, Apple Watch, Link a watch.").font(.caption2).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(.horizontal, 10)
                    } else {
                        ProgressView("Getting a code")
                    }
                    if let n = session.notice { Text(n).font(.caption2).foregroundStyle(.orange).multilineTextAlignment(.center).padding(.horizontal, 10) }
                    Button("Enter a game code") { session.clearNotice(); entering = true }.padding(.horizontal, 10)
                    if session.hasLink {
                        Button("Cancel") { session.cancelRelink() }.padding(.horizontal, 10)
                    }
                }
            }
        }
        .ignoresSafeArea(.container, edges: .horizontal)
    }
}
