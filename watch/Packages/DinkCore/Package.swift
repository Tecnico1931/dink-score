// swift-tools-version:5.9
// DinkCore: everything the watch app does that is not drawing. Pure Swift (Foundation, CryptoKit, Security), so `swift test` runs it on the Mac.
import PackageDescription

let package = Package(
    name: "DinkCore",
    platforms: [.watchOS(.v10), .macOS(.v14), .iOS(.v17)],
    products: [.library(name: "DinkCore", targets: ["DinkCore"])],
    targets: [
        .target(name: "DinkCore"),
        .testTarget(name: "DinkCoreTests", dependencies: ["DinkCore"], resources: [.copy("Fixtures")]),
    ],
    swiftLanguageVersions: [.v5]
)
