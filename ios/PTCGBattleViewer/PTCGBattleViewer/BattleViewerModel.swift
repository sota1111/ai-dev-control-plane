import Foundation
import Combine

enum CompactLayoutMetrics {
    static let horizontalPadding: CGFloat = 8
    static let verticalPadding: CGFloat = 4
    static let sectionSpacing: CGFloat = 4
    static let timelineHeight: CGFloat = 124
    static let playerBoardHeight: CGFloat = 250
    static let iPhone14MinimumContentHeight: CGFloat = 640
    static let totalContentHeight =
        verticalPadding * 2 + timelineHeight + sectionSpacing + playerBoardHeight * 2
}

@MainActor
final class BattleViewerModel: ObservableObject {
    @Published private(set) var battleId = ""
    @Published private(set) var snapshots: [ReplaySnapshot] = []
    @Published var position = 0
    @Published var errorMessage: String?

    var current: ReplaySnapshot? { snapshots.indices.contains(position) ? snapshots[position] : nil }
    var eventDescription: String { current?.event?.description ?? "対戦開始時の盤面" }
    var canGoBack: Bool { position > 0 }
    var canGoForward: Bool { position + 1 < snapshots.count }

    func load(_ data: Data) {
        do {
            let result = try BattleReplay.decode(data)
            battleId = result.0.battleId
            snapshots = result.1
            position = 0
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func showError(_ error: Error) { errorMessage = error.localizedDescription }
    func first() { position = 0 }
    func previous() { position = max(0, position - 1) }
    func next() { position = min(max(0, snapshots.count - 1), position + 1) }
    func last() { position = max(0, snapshots.count - 1) }
}
