import SwiftUI
import DinkCore

/// The pairing code, drawn on a white square with whole-point modules so the edges stay sharp for a phone camera.
struct QRView: View {
    let text: String
    @Environment(\.displayScale) private var scale

    var body: some View {
        if let qr = try? QRMatrix(text, level: .M) {
            Canvas { ctx, size in
                // The white square is the whole frame; modules are a whole number of device pixels so no edge is blurred.
                let quiet = 2, count = qr.size + 2 * quiet
                let cell = max(1 / scale, floor(min(size.width, size.height) * scale / CGFloat(count)) / scale)
                let side = cell * CGFloat(count)
                let origin = CGPoint(x: ((size.width - side) / 2 * scale).rounded() / scale, y: ((size.height - side) / 2 * scale).rounded() / scale)
                ctx.fill(Path(CGRect(origin: .zero, size: size)), with: .color(.white))
                var dark = Path()
                for r in 0..<qr.size { for c in 0..<qr.size where qr.isDark(r, c) {
                    dark.addRect(CGRect(x: origin.x + CGFloat(c + quiet) * cell, y: origin.y + CGFloat(r + quiet) * cell, width: cell, height: cell))
                } }
                ctx.fill(dark, with: .color(.black))
            }
            .aspectRatio(1, contentMode: .fit)
        } else {
            Text("The link code could not be drawn. Type the code below instead.").font(.footnote)
        }
    }
}
