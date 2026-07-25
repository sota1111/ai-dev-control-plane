import SwiftUI
import UniformTypeIdentifiers

struct ContentView: View {
    @StateObject private var model = BattleViewerModel()
    @State private var importing = false

    var body: some View {
        NavigationStack {
            Group {
                if let snapshot = model.current {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            timeline(snapshot)
                            BattleArenaView(state: snapshot.state)
                        }.padding()
                    }
                } else {
                    ContentUnavailableView("対戦ログを選択", systemImage: "doc.badge.plus", description: Text("ptcg-battle-log/v1 のJSONファイルを読み込みます"))
                }
            }
            .navigationTitle("対戦タイムライン")
            .toolbar { Button("ログを開く", systemImage: "folder") { importing = true } }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
                do {
                    let url = try result.get()
                    guard url.startAccessingSecurityScopedResource() else { throw CocoaError(.fileReadNoPermission) }
                    defer { url.stopAccessingSecurityScopedResource() }
                    model.load(try Data(contentsOf: url))
                } catch { model.showError(error) }
            }
            .alert("読み込みエラー", isPresented: Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })) {
                Button("OK", role: .cancel) {}
            } message: { Text(model.errorMessage ?? "") }
        }
    }

    private func timeline(_ snapshot: ReplaySnapshot) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(model.battleId).font(.caption).foregroundStyle(.secondary)
            HStack {
                Label("時点 \(model.position) / \(model.snapshots.count - 1)", systemImage: "clock")
                Spacer()
                Text("ターン \(snapshot.state.turn)")
            }
            Text(model.eventDescription).font(.headline).padding().frame(maxWidth: .infinity, alignment: .leading).background(.blue.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
            Slider(value: Binding(get: { Double(model.position) }, set: { model.position = Int($0) }), in: 0...Double(max(1, model.snapshots.count - 1)), step: 1)
                .disabled(model.snapshots.count <= 1)
            HStack {
                Button("先頭", systemImage: "backward.end.fill", action: model.first).disabled(!model.canGoBack)
                Button("前", systemImage: "backward.fill", action: model.previous).disabled(!model.canGoBack)
                Spacer()
                Button("次", systemImage: "forward.fill", action: model.next).disabled(!model.canGoForward)
                Button("末尾", systemImage: "forward.end.fill", action: model.last).disabled(!model.canGoForward)
            }.buttonStyle(.bordered)
            if let winner = snapshot.state.winner { Label("勝者: \(winner)", systemImage: "trophy.fill").foregroundStyle(.green) }
        }
    }
}

private struct BattleArenaView: View {
    let state: BoardState

    var body: some View {
        Group {
            if let seats = BoardSeatLayout(players: state.players.keys),
               let opponent = state.players[seats.opponent],
               let viewer = state.players[seats.viewer] {
                VStack(spacing: 0) {
                    PlayerBoardView(
                        name: seats.opponent,
                        role: "対戦相手",
                        board: opponent,
                        isCurrent: state.currentPlayer == seats.opponent,
                        isOpponent: true
                    )
                    Divider().overlay(.white.opacity(0.55))
                    PlayerBoardView(
                        name: seats.viewer,
                        role: "あなた",
                        board: viewer,
                        isCurrent: state.currentPlayer == seats.viewer,
                        isOpponent: false
                    )
                }
                .background(
                    LinearGradient(
                        colors: [.indigo.opacity(0.2), .cyan.opacity(0.12), .blue.opacity(0.24)],
                        startPoint: .top,
                        endPoint: .bottom
                    ),
                    in: RoundedRectangle(cornerRadius: 24)
                )
                .overlay(RoundedRectangle(cornerRadius: 24).stroke(.blue.opacity(0.35)))
                .accessibilityIdentifier("battle-arena")
            } else {
                ContentUnavailableView("盤面を表示できません", systemImage: "rectangle.split.2x1")
            }
        }
    }
}

private struct PlayerBoardView: View {
    let name: String
    let role: String
    let board: PlayerBoardState
    let isCurrent: Bool
    let isOpponent: Bool

    var body: some View {
        VStack(spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(role).font(.caption).foregroundStyle(.secondary)
                    Text(name).font(.title2.bold())
                }
                if isCurrent {
                    Label("行動中", systemImage: "bolt.fill")
                        .font(.caption.bold())
                        .padding(.horizontal, 9)
                        .padding(.vertical, 5)
                        .background(.yellow, in: Capsule())
                        .foregroundStyle(.black)
                }
                Spacer()
                count("サイド", board.prizesRemaining, icon: "seal.fill")
            }

            HStack(alignment: .center, spacing: 10) {
                pile("山札", value: board.deckCount, icon: "rectangle.stack.fill")
                CardView(card: board.active, zone: "バトル場", emphasized: true)
                pile("トラッシュ", value: board.discard.count, icon: "trash.fill")
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("ベンチ").font(.caption.bold()).foregroundStyle(.secondary)
                if board.bench.isEmpty {
                    Text("ポケモンなし")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, minHeight: 72)
                        .background(.white.opacity(0.3), in: RoundedRectangle(cornerRadius: 12))
                } else {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack { ForEach(board.bench) { CardView(card: $0, zone: nil, emphasized: false) } }
                    }
                }
            }

            HStack {
                Label("手札", systemImage: "rectangle.stack")
                    .font(.caption.bold())
                CardBackFan(count: board.handCount, isOpponent: isOpponent)
                Spacer()
                Text("\(board.handCount)枚").font(.headline.monospacedDigit())
            }

            DisclosureGroup("トラッシュの内容") {
                Text(board.discard.isEmpty ? "なし" : board.discard.joined(separator: ", "))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .font(.caption)
        }
        .padding()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(role) \(name) の盤面")
    }

    private func count(_ label: String, _ value: Int, icon: String) -> some View {
        Label("\(label) \(value)", systemImage: icon)
            .font(.caption.bold())
            .padding(7)
            .background(.background.opacity(0.8), in: Capsule())
    }

    private func pile(_ label: String, value: Int, icon: String) -> some View {
        VStack(spacing: 4) {
            Image(systemName: icon).font(.title2)
            Text("\(value)").font(.headline.monospacedDigit())
            Text(label).font(.caption2)
        }
        .frame(width: 58)
        .frame(minHeight: 88)
        .background(.background.opacity(0.82), in: RoundedRectangle(cornerRadius: 12))
    }
}

private struct CardView: View {
    let card: CardState?
    let zone: String?
    let emphasized: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            if let zone { Text(zone).font(.caption2.bold()).foregroundStyle(.secondary) }
            HStack {
                Image(systemName: card == nil ? "plus" : "bolt.shield.fill")
                Text(card?.name ?? "ポケモンなし").font(.headline).lineLimit(1)
            }
            if let card {
                let remainingHp = max(0, card.maxHp - card.damage)
                ProgressView(value: Double(remainingHp), total: Double(max(1, card.maxHp)))
                    .tint(remainingHp * 3 > card.maxHp ? .green : .red)
                HStack {
                    Text("HP \(remainingHp)/\(card.maxHp)")
                    Spacer()
                    Text("ダメージ \(card.damage)")
                }
                .font(.caption.monospacedDigit())
                Label(
                    card.energy.isEmpty ? "エネルギーなし" : card.energy.joined(separator: "・"),
                    systemImage: "bolt.circle.fill"
                )
                .font(.caption)
                .lineLimit(1)
                Label(card.attacks?.joined(separator: "・").nilIfEmpty ?? "技なし", systemImage: "burst.fill")
                .font(.caption.bold())
                .lineLimit(2)
            }
        }
        .padding(10)
        .frame(minWidth: emphasized ? 176 : 132, minHeight: emphasized ? 132 : 94, alignment: .leading)
        .background(.background.opacity(0.94), in: RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(emphasized ? Color.cyan : Color.secondary.opacity(0.45), lineWidth: emphasized ? 3 : 1)
        )
        .shadow(color: emphasized ? .cyan.opacity(0.25) : .clear, radius: 8)
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

private struct CardBackFan: View {
    let count: Int
    let isOpponent: Bool

    var body: some View {
        HStack(spacing: -12) {
            ForEach(0..<min(count, 6), id: \.self) { index in
                RoundedRectangle(cornerRadius: 5)
                    .fill(
                        LinearGradient(
                            colors: [.blue, .indigo],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .overlay(Image(systemName: "circle.circle.fill").font(.caption).foregroundStyle(.white))
                    .frame(width: 30, height: 42)
                    .rotationEffect(.degrees(Double(index - min(count, 6) / 2) * (isOpponent ? -2 : 2)))
            }
        }
        .frame(minWidth: 32, minHeight: 44)
        .accessibilityLabel("手札 \(count) 枚")
    }
}
