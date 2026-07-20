# PTCG agent environment contract tests

松・竹・梅・Zero adapterは、アルゴリズムに依存しない同じ環境境界を実装する。
`src/__tests__/ptcgAgentEnvironmentContract.test.ts` の共通suiteは、4 adapter fixtureすべてに
次の検査を適用する。

- ObservationのJSON round-trip
- adapter identityとcurrent configuration schemaの整合
- Action Spaceの一意なIDとLegal Action Mask／合法手列挙の完全一致
- 自分の手札だけがprivate stateにあり、相手は公開可能な枚数だけであること
- 未知のschema version、非公開情報field、矛盾したmaskを明示的に拒否すること

新しいadapter実装は `src/testing/ptcgAgentContractFixtures.ts` と同じ
`PtcgAgentContractFixture` を用意し、`runEnvironmentContract` 相当の共通suiteへ渡す。
fixtureには決定的な最小局面を使い、adapter固有のplannerやscoreをcontractへ持ち込まない。

ローカルでは次で契約テストだけを実行できる。

```sh
npm test -- --runInBand src/__tests__/ptcgAgentEnvironmentContract.test.ts
```

通常の `npm test` に含まれるため、`.github/workflows/ci.yml` のpull request jobでも毎回実行される。
