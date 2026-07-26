import SwiftUI
import UniformTypeIdentifiers

struct ContentView: View {
    @StateObject private var model = BattleViewerModel()
    @State private var importing = false

    var body: some View {
        NavigationStack {
            Group {
                if let snapshot = model.current {
                    GeometryReader { proxy in
                        VStack(alignment: .leading, spacing: CompactLayoutMetrics.sectionSpacing) {
                            timeline(snapshot)
                            BattleArenaView(state: snapshot.state)
                        }
                        .padding(.horizontal, CompactLayoutMetrics.horizontalPadding)
                        .padding(.vertical, CompactLayoutMetrics.verticalPadding)
                        .frame(width: proxy.size.width, height: proxy.size.height, alignment: .top)
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
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(model.battleId).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                Spacer()
                Label("\(model.position)/\(model.snapshots.count - 1)", systemImage: "clock")
                Text("T\(snapshot.state.turn)")
            }
            .font(.caption.bold())
            Text(model.eventDescription)
                .font(.caption.bold())
                .lineLimit(2)
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.blue.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
            Slider(value: Binding(get: { Double(model.position) }, set: { model.position = Int($0) }), in: 0...Double(max(1, model.snapshots.count - 1)), step: 1)
                .disabled(model.snapshots.count <= 1)
            HStack {
                timelineButton("先頭", systemImage: "backward.end.fill", action: model.first).disabled(!model.canGoBack)
                timelineButton("前", systemImage: "backward.fill", action: model.previous).disabled(!model.canGoBack)
                Spacer()
                if let winner = snapshot.state.winner {
                    Label(winner, systemImage: "trophy.fill").font(.caption2.bold()).foregroundStyle(.green)
                }
                Spacer()
                timelineButton("次", systemImage: "forward.fill", action: model.next).disabled(!model.canGoForward)
                timelineButton("末尾", systemImage: "forward.end.fill", action: model.last).disabled(!model.canGoForward)
            }
        }
        .frame(height: CompactLayoutMetrics.timelineHeight)
        .accessibilityIdentifier("compact-timeline")
    }

    private func timelineButton(_ label: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .frame(width: 32, height: 28)
        }
        .buttonStyle(.bordered)
        .accessibilityLabel(label)
    }
}

struct BattleArenaView: View {
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
                .frame(height: CompactLayoutMetrics.playerBoardHeight * 2)
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

struct PlayerBoardView: View {
    let name: String
    let role: String
    let board: PlayerBoardState
    let isCurrent: Bool
    let isOpponent: Bool

    var body: some View {
        VStack(spacing: 5) {
            HStack {
                Text(role).font(.caption2).foregroundStyle(.secondary)
                Text(name).font(.caption.bold()).lineLimit(1)
                if isCurrent {
                    Label("行動中", systemImage: "bolt.fill")
                        .font(.caption2.bold())
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background(.yellow, in: Capsule())
                        .foregroundStyle(.black)
                }
                Spacer()
                count("手札", board.handCount, icon: "rectangle.stack")
                count("サイド", board.prizesRemaining, icon: "seal.fill")
            }

            HStack(alignment: .center, spacing: 5) {
                pile("山札", value: board.deckCount, icon: "rectangle.stack.fill")
                CardView(card: board.active, zone: "バトル場", emphasized: true)
                pile("トラッシュ", value: board.discard.count, icon: "trash.fill")
            }

            VStack(alignment: .leading, spacing: 2) {
                Text("ベンチ").font(.caption2.bold()).foregroundStyle(.secondary)
                if board.bench.isEmpty {
                    Text("ポケモンなし")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, minHeight: 48)
                        .background(.white.opacity(0.3), in: RoundedRectangle(cornerRadius: 8))
                } else {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 4) { ForEach(board.bench) { CardView(card: $0, zone: nil, emphasized: false) } }
                    }
                }
            }
        }
        .padding(7)
        .frame(height: CompactLayoutMetrics.playerBoardHeight)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(role) \(name) の盤面")
    }

    private func count(_ label: String, _ value: Int, icon: String) -> some View {
        Label("\(label) \(value)", systemImage: icon)
            .font(.caption2.bold())
            .padding(4)
            .background(.background.opacity(0.8), in: Capsule())
    }

    private func pile(_ label: String, value: Int, icon: String) -> some View {
        VStack(spacing: 2) {
            Image(systemName: icon).font(.caption)
            Text("\(value)").font(.caption.bold().monospacedDigit())
            Text(label).font(.caption2)
        }
        .frame(width: 42, height: 72)
        .background(.background.opacity(0.82), in: RoundedRectangle(cornerRadius: 8))
    }
}

private struct CardView: View {
    let card: CardState?
    let zone: String?
    let emphasized: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let zone { Text(zone).font(.caption2.bold()).foregroundStyle(.secondary) }
            HStack {
                Image(systemName: card == nil ? "plus" : "bolt.shield.fill")
                Text(card?.name ?? "ポケモンなし").font(.caption.bold()).lineLimit(1)
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
                .font(.caption2.monospacedDigit())
                Label(
                    card.energy.isEmpty ? "エネルギーなし" : card.energy.joined(separator: "・"),
                    systemImage: "bolt.circle.fill"
                )
                .font(.caption2)
                .lineLimit(1)
                Label(
                    card.attacks?.map(\.displayText).joined(separator: "・").nilIfEmpty ?? "技なし",
                    systemImage: "burst.fill"
                )
                .font(.caption2.bold())
                .lineLimit(1)
            }
        }
        .padding(6)
        .frame(minWidth: emphasized ? 180 : 112, minHeight: emphasized ? 104 : 48, alignment: .leading)
        .background(.background.opacity(0.94), in: RoundedRectangle(cornerRadius: 9))
        .overlay(
            RoundedRectangle(cornerRadius: 9)
                .stroke(emphasized ? Color.cyan : Color.secondary.opacity(0.45), lineWidth: emphasized ? 3 : 1)
        )
        .shadow(color: emphasized ? .cyan.opacity(0.2) : .clear, radius: 4)
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
