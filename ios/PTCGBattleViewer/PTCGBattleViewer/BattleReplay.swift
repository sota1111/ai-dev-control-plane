import Foundation

struct AttackState: Codable, Equatable {
    let name: String
    let damage: String?
    let cost: [String]

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let legacyName = try? container.decode(String.self) {
            name = legacyName
            damage = nil
            cost = []
            return
        }
        let value = try container.decode(StructuredAttack.self)
        name = value.name
        damage = value.damage
        cost = value.cost
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(StructuredAttack(name: name, damage: damage, cost: cost))
    }

    var displayText: String {
        let damageText = damage.map { " \($0)" } ?? ""
        let costText = cost.isEmpty ? "なし" : cost.joined(separator: "・")
        return "\(name)\(damageText)（必要エネルギー \(costText)）"
    }

    private struct StructuredAttack: Codable {
        let name: String
        let damage: String?
        let cost: [String]
    }
}

struct CardState: Codable, Equatable, Identifiable {
    let id: String
    let name: String
    let maxHp: Int
    var damage: Int
    var energy: [String]
    var attacks: [AttackState]?
}

struct PlayerBoardState: Codable, Equatable {
    var active: CardState?
    var bench: [CardState]
    var deckCount: Int
    var handCount: Int
    var discard: [String]
    var prizesRemaining: Int
}

struct BoardState: Codable, Equatable {
    var turn: Int
    var currentPlayer: String
    var players: [String: PlayerBoardState]
    var winner: String?
}

enum BattleEvent: Decodable, Equatable {
    case draw(player: String, count: Int)
    case playActive(player: String, card: CardState)
    case playBench(player: String, card: CardState)
    case attachEnergy(player: String, targetId: String, energy: String)
    case damage(player: String, targetId: String, amount: Int)
    case knockout(player: String, targetId: String)
    case takePrize(player: String, count: Int)
    case endTurn(nextPlayer: String)
    case declareWinner(player: String)

    private enum CodingKeys: String, CodingKey {
        case type, player, count, card, targetId, energy, amount, nextPlayer
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        switch try values.decode(String.self, forKey: .type) {
        case "draw":
            self = try .draw(player: values.decode(String.self, forKey: .player), count: values.decode(Int.self, forKey: .count))
        case "play-active":
            self = try .playActive(player: values.decode(String.self, forKey: .player), card: values.decode(CardState.self, forKey: .card))
        case "play-bench":
            self = try .playBench(player: values.decode(String.self, forKey: .player), card: values.decode(CardState.self, forKey: .card))
        case "attach-energy":
            self = try .attachEnergy(player: values.decode(String.self, forKey: .player), targetId: values.decode(String.self, forKey: .targetId), energy: values.decode(String.self, forKey: .energy))
        case "damage":
            self = try .damage(player: values.decode(String.self, forKey: .player), targetId: values.decode(String.self, forKey: .targetId), amount: values.decode(Int.self, forKey: .amount))
        case "knockout":
            self = try .knockout(player: values.decode(String.self, forKey: .player), targetId: values.decode(String.self, forKey: .targetId))
        case "take-prize":
            self = try .takePrize(player: values.decode(String.self, forKey: .player), count: values.decode(Int.self, forKey: .count))
        case "end-turn":
            self = try .endTurn(nextPlayer: values.decode(String.self, forKey: .nextPlayer))
        case "declare-winner":
            self = try .declareWinner(player: values.decode(String.self, forKey: .player))
        default:
            throw DecodingError.dataCorruptedError(forKey: .type, in: values, debugDescription: "Unsupported battle event")
        }
    }

    var description: String {
        switch self {
        case let .draw(player, count): return "\(player) が山札から \(count) 枚引いた"
        case let .playActive(player, card): return "\(player) が \(card.name) をバトル場に出した"
        case let .playBench(player, card): return "\(player) が \(card.name) をベンチに出した"
        case let .attachEnergy(player, targetId, energy): return "\(player) が \(targetId) に \(energy) エネルギーを付けた"
        case let .damage(player, targetId, amount): return "\(player) の \(targetId) に \(amount) ダメージ"
        case let .knockout(player, targetId): return "\(player) の \(targetId) がきぜつ"
        case let .takePrize(player, count): return "\(player) がサイドを \(count) 枚取った"
        case let .endTurn(nextPlayer): return "ターン終了。次は \(nextPlayer)"
        case let .declareWinner(player): return "\(player) の勝利"
        }
    }
}

struct BattleLog: Decodable {
    let schemaVersion: String
    let battleId: String
    let initialState: BoardState
    let events: [BattleEvent]
}

struct ReplaySnapshot: Equatable {
    let event: BattleEvent?
    let state: BoardState
}

struct BoardSeatLayout: Equatable {
    let opponent: String
    let viewer: String

    init?(players: some Sequence<String>) {
        let names = Array(Set(players)).sorted()
        guard names.count >= 2 else { return nil }
        opponent = names[1]
        viewer = names[0]
    }
}

enum BattleReplayError: LocalizedError {
    case unsupportedSchema
    case invalid(String)

    var errorDescription: String? {
        switch self {
        case .unsupportedSchema: return "ptcg-battle-log/v1 形式のログを選択してください。"
        case let .invalid(message): return "ログを再生できません: \(message)"
        }
    }
}

enum BattleReplay {
    static func decode(_ data: Data) throws -> (BattleLog, [ReplaySnapshot]) {
        let log = try JSONDecoder().decode(BattleLog.self, from: data)
        guard log.schemaVersion == "ptcg-battle-log/v1" else { throw BattleReplayError.unsupportedSchema }
        var state = log.initialState
        guard state.players.count >= 2, state.players[state.currentPlayer] != nil else {
            throw BattleReplayError.invalid("初期盤面のプレイヤーが不正です")
        }
        var snapshots = [ReplaySnapshot(event: nil, state: state)]
        for event in log.events {
            try apply(event, to: &state)
            snapshots.append(ReplaySnapshot(event: event, state: state))
        }
        return (log, snapshots)
    }

    private static func apply(_ event: BattleEvent, to state: inout BoardState) throws {
        func board(_ player: String) throws -> PlayerBoardState {
            guard let value = state.players[player] else { throw BattleReplayError.invalid("不明なプレイヤー \(player)") }
            return value
        }
        switch event {
        case let .draw(player, count):
            var value = try board(player)
            guard count > 0, value.deckCount >= count else { throw BattleReplayError.invalid("ドロー枚数が不正です") }
            value.deckCount -= count; value.handCount += count; state.players[player] = value
        case let .playActive(player, card):
            var value = try board(player)
            guard value.active == nil, value.handCount > 0 else { throw BattleReplayError.invalid("バトル場にカードを出せません") }
            value.active = card; value.handCount -= 1; state.players[player] = value
        case let .playBench(player, card):
            var value = try board(player)
            guard value.bench.count < 5, value.handCount > 0 else { throw BattleReplayError.invalid("ベンチにカードを出せません") }
            value.bench.append(card); value.handCount -= 1; state.players[player] = value
        case let .attachEnergy(player, targetId, energy):
            var value = try board(player)
            try mutateCard(targetId, on: &value) { $0.energy.append(energy) }
            state.players[player] = value
        case let .damage(player, targetId, amount):
            guard amount > 0 else { throw BattleReplayError.invalid("ダメージ量が不正です") }
            var value = try board(player)
            try mutateCard(targetId, on: &value) { $0.damage += amount }
            state.players[player] = value
        case let .knockout(player, targetId):
            var value = try board(player)
            if let active = value.active, active.id == targetId, active.damage >= active.maxHp {
                value.discard.append(contentsOf: [active.id] + active.energy); value.active = nil
            } else if let index = value.bench.firstIndex(where: { $0.id == targetId && $0.damage >= $0.maxHp }) {
                let card = value.bench.remove(at: index); value.discard.append(contentsOf: [card.id] + card.energy)
            } else { throw BattleReplayError.invalid("きぜつ対象が不正です") }
            state.players[player] = value
        case let .takePrize(player, count):
            var value = try board(player)
            guard count > 0, value.prizesRemaining >= count else { throw BattleReplayError.invalid("サイド枚数が不正です") }
            value.prizesRemaining -= count; value.handCount += count; state.players[player] = value
        case let .endTurn(nextPlayer):
            _ = try board(nextPlayer); state.turn += 1; state.currentPlayer = nextPlayer
        case let .declareWinner(player):
            _ = try board(player)
            guard state.winner == nil else { throw BattleReplayError.invalid("勝者が重複しています") }
            state.winner = player
        }
    }

    private static func mutateCard(_ id: String, on board: inout PlayerBoardState, change: (inout CardState) -> Void) throws {
        if board.active?.id == id { change(&board.active!); return }
        if let index = board.bench.firstIndex(where: { $0.id == id }) { change(&board.bench[index]); return }
        throw BattleReplayError.invalid("場に存在しないカード \(id)")
    }
}
