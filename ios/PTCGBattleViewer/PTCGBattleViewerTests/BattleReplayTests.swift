import XCTest
@testable import PTCGBattleViewer

final class BattleReplayTests: XCTestCase {
    private let log = """
    {"schemaVersion":"ptcg-battle-log/v1","battleId":"ios-test","initialState":{"turn":1,"currentPlayer":"matsu","players":{"matsu":{"active":null,"bench":[],"deckCount":2,"handCount":1,"discard":[],"prizesRemaining":6},"take":{"active":null,"bench":[],"deckCount":2,"handCount":1,"discard":[],"prizesRemaining":6}},"winner":null},"events":[{"type":"draw","player":"matsu","count":1},{"type":"end-turn","nextPlayer":"take"},{"type":"declare-winner","player":"take"}]}
    """.data(using: .utf8)!

    func testReplaysInitialStateAndEveryEvent() throws {
        let (battle, snapshots) = try BattleReplay.decode(log)
        XCTAssertEqual(battle.battleId, "ios-test")
        XCTAssertEqual(snapshots.count, 4)
        XCTAssertNil(snapshots[0].event)
        XCTAssertEqual(snapshots[1].state.players["matsu"]?.handCount, 2)
        XCTAssertEqual(snapshots[2].state.currentPlayer, "take")
        XCTAssertEqual(snapshots[3].state.winner, "take")
    }

    @MainActor
    func testNavigationIsBoundedAndSupportsArbitraryPosition() {
        let model = BattleViewerModel()
        model.load(log)
        model.previous()
        XCTAssertEqual(model.position, 0)
        model.last()
        XCTAssertEqual(model.position, 3)
        model.next()
        XCTAssertEqual(model.position, 3)
        model.position = 1
        XCTAssertEqual(model.eventDescription, "matsu が山札から 1 枚引いた")
        model.first()
        XCTAssertEqual(model.eventDescription, "対戦開始時の盤面")
    }
}
