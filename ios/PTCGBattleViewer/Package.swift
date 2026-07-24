// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "PTCGBattleViewerCore",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "PTCGBattleViewer", targets: ["PTCGBattleViewer"])
    ],
    targets: [
        .target(
            name: "PTCGBattleViewer",
            path: "PTCGBattleViewer",
            sources: ["BattleReplay.swift", "BattleViewerModel.swift"]
        ),
        .testTarget(
            name: "PTCGBattleViewerTests",
            dependencies: ["PTCGBattleViewer"],
            path: "PTCGBattleViewerTests"
        )
    ]
)
