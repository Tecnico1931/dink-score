import SwiftUI
import DinkCore

/// The pairing code, drawn on a white square with whole-point modules so the edges stay sharp for a phone camera.
struct QRView: View {
    let text: String

    var body: some View {
        if let qr = try? QRMatrix(text, level: .M) {
            Canvas { ctx, size in
                let quiet = 2, count = qr.size + 2 * quiet
                let cell = max(1, floor(min(size.width, size.height) / CGFloat(count)))
                let side = cell * CGFloat(count)
                let origin = CGPoint(x: (size.width - side) / 2, y: (size.height - side) / 2)
                ctx.fill(Path(CGRect(origin: origin, size: CGSize(width: side, height: side))), with: .color(.white))
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
