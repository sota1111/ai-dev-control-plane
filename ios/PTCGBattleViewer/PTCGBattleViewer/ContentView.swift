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
                        VStack(alignment: .leading, spacing: 16) {
                            timeline(snapshot)
                            ForEach(snapshot.state.players.keys.sorted(), id: \.self) { player in
                                PlayerBoardView(name: player, board: snapshot.state.players[player]!, isCurrent: snapshot.state.currentPlayer == player)
                            }
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

private struct PlayerBoardView: View {
    let name: String
    let board: PlayerBoardState
    let isCurrent: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack { Text(name).font(.title2.bold()); if isCurrent { Text("現在").font(.caption).padding(5).background(.blue, in: Capsule()).foregroundStyle(.white) } }
            HStack { count("手札", board.handCount); count("山札", board.deckCount); count("サイド", board.prizesRemaining); count("トラッシュ", board.discard.count) }
            Text("バトル場").font(.headline)
            CardView(card: board.active)
            Text("ベンチ").font(.headline)
            if board.bench.isEmpty { Text("ポケモンなし").foregroundStyle(.secondary) }
            else { ScrollView(.horizontal) { HStack { ForEach(board.bench) { CardView(card: $0) } } } }
            DisclosureGroup("トラッシュの内容") { Text(board.discard.isEmpty ? "なし" : board.discard.joined(separator: ", ")).frame(maxWidth: .infinity, alignment: .leading) }
        }.padding().background(.secondary.opacity(0.09), in: RoundedRectangle(cornerRadius: 16))
    }

    private func count(_ label: String, _ value: Int) -> some View {
        VStack { Text("\(value)").font(.headline); Text(label).font(.caption2) }.frame(maxWidth: .infinity)
    }
}

private struct CardView: View {
    let card: CardState?
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(card?.name ?? "ポケモンなし").font(.headline)
            if let card {
                Text("HP \(max(0, card.maxHp - card.damage))/\(card.maxHp)")
                Text("ダメージ \(card.damage)")
                Text("エネルギー \(card.energy.isEmpty ? "なし" : card.energy.joined(separator: ", "))")
            }
        }.padding().frame(minWidth: 150, alignment: .leading).background(.background, in: RoundedRectangle(cornerRadius: 12)).overlay(RoundedRectangle(cornerRadius: 12).stroke(.secondary))
    }
}
