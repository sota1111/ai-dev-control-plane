import {
  PtcgDataError,
  generateLegalDeckCandidates,
  loadCardDataCsv,
  loadDeckCsv,
  validateDeck,
} from '../lib/ptcgDeck.js';

const HEADER =
  'Card ID,Card Name,Expansion,Collection No.,Stage (Pokémon)/Type (Energy and Trainer),Rule,Category,Previous stage,HP,Type,Weakness,Resistance (Type),Retreat,Move Name,Cost,Damage,Effect Explanation';
const FIXTURE = `${HEADER}
1,Basic {G} Energy,SVE,1,Basic Energy,n/a,n/a,n/a,n/a,{G},,,n/a,,n/a,n/a,
2,Seedling,TST,1,Basic Pokémon,n/a,n/a,n/a,60,{G},{R},n/a,1,Tackle,{G},10,"Draw, then discard."
2,Seedling,TST,1,Basic Pokémon,n/a,n/a,n/a,60,{G},{R},n/a,1,Grow,{G}{G},20,n/a
3,Bloom,TST,2,Stage 1 Pokémon,n/a,n/a,Seedling,120,{G},{R},n/a,2,Leaf,{G}{G},60,n/a
4,Power Search,TST,3,Item,ACE SPEC,n/a,n/a,n/a,n/a,,,n/a,,n/a,n/a,"Search your deck."
5,Research,TST,4,Supporter,n/a,n/a,n/a,n/a,n/a,,,n/a,,n/a,n/a,Draw cards.
6,Research,TST,5,Supporter,n/a,n/a,n/a,n/a,n/a,,,n/a,,n/a,n/a,Draw cards.
`;

describe('PTCG competition card and deck model', () => {
  const cards = loadCardDataCsv(FIXTURE);

  it('loads competition-style CSV, including repeated move rows and quoted multiline-safe fields', () => {
    expect(cards.size).toBe(6);
    expect(cards.get(2)).toMatchObject({ name: 'Seedling', kind: 'pokemon', hp: 60, retreat: 1 });
    expect(cards.get(2)?.moves).toHaveLength(2);
    expect(cards.get(2)?.moves[0].effect).toBe('Draw, then discard.');
  });

  it('loads one-card-id-per-line deck.csv and rejects malformed rows', () => {
    expect(loadDeckCsv('2\r\n1\n\n5\n')).toEqual([2, 1, 5]);
    expect(() => loadDeckCsv('2\nnot-an-id\n')).toThrow(/deck row 2/);
  });

  it('accepts the 60-card boundary with unlimited Basic Energy', () => {
    const deck = [2, 2, 2, 2, 3, 3, 3, 3, 4, 5, 5, 5, 5, ...Array(47).fill(1)];
    expect(deck).toHaveLength(60);
    expect(validateDeck(deck, cards)).toEqual({ legal: true, errors: [] });
  });

  it.each([
    ['wrong size', [2, ...Array(58).fill(1)], /exactly 60/],
    ['unknown id', [2, 999, ...Array(58).fill(1)], /unknown card ID/],
    [
      'same-name printings over four',
      [2, ...Array(3).fill(1), ...Array(3).fill(5), ...Array(2).fill(6), ...Array(51).fill(1)],
      /Research exceeds/,
    ],
    ['more than one ACE SPEC', [2, 4, 4, ...Array(57).fill(1)], /ACE SPEC exceeds/],
    ['no Basic Pokémon', [3, ...Array(59).fill(1)], /Basic Pokémon/],
  ])('rejects %s', (_name, deck, expected) => {
    const result = validateDeck(deck as number[], cards);
    expect(result.legal).toBe(false);
    expect(result.errors.join('\n')).toMatch(expected as RegExp);
  });

  it('generates only legal candidates and reproduces identical output for the same seed', () => {
    const first = generateLegalDeckCandidates({ cards, seed: 20260720, count: 12 });
    const second = generateLegalDeckCandidates({ cards, seed: 20260720, count: 12 });
    expect(first).toEqual(second);
    expect(first).toHaveLength(12);
    expect(first.every((deck) => validateDeck(deck, cards).legal)).toBe(true);
    expect(generateLegalDeckCandidates({ cards, seed: 20260721, count: 12 })).not.toEqual(first);
  });

  it('reports missing and inconsistent competition data explicitly', () => {
    expect(() => loadCardDataCsv('Card ID,Card Name\n1,foo')).toThrow(/missing required column/);
    expect(() => loadCardDataCsv(`${HEADER}\nnope,Foo,T,1,Item`)).toThrow(PtcgDataError);
    expect(() => loadCardDataCsv(`${FIXTURE}2,Other,TST,1,Basic Pokémon`)).toThrow(
      /inconsistent duplicate/
    );
  });
});
