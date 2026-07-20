import fs from 'node:fs';

export const PTCG_DECK_SIZE = 60;

export type CardKind = 'pokemon' | 'trainer' | 'energy';

export interface PtcgCardMove {
  name: string;
  cost?: string;
  damage?: string;
  effect?: string;
}

export interface PtcgCard {
  id: number;
  name: string;
  expansion: string;
  collectionNumber: string;
  stageOrType: string;
  kind: CardKind;
  rule?: string;
  category?: string;
  previousStage?: string;
  hp?: number;
  type?: string;
  weakness?: string;
  resistance?: string;
  retreat?: number;
  moves: PtcgCardMove[];
}

export interface PtcgBoardState {
  activeCardId?: number;
  benchCardIds: number[];
  handCardIds: number[];
  deckCardIds: number[];
  discardCardIds: number[];
  prizeCardIds: number[];
  attachedEnergyByCardId: Record<number, number[]>;
}

export interface DeckRules {
  deckSize: number;
  maxCopiesByName: number;
  maxAceSpec: number;
  requireBasicPokemon: boolean;
}

export const KAGGLE_DECK_RULES: Readonly<DeckRules> = Object.freeze({
  deckSize: PTCG_DECK_SIZE,
  maxCopiesByName: 4,
  maxAceSpec: 1,
  requireBasicPokemon: true,
});

export class PtcgDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PtcgDataError';
  }
}

export interface DeckValidationResult {
  legal: boolean;
  errors: string[];
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  if (quoted) throw new PtcgDataError('card CSV has an unterminated quoted field');
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows;
}

const REQUIRED_COLUMNS = [
  'Card ID',
  'Card Name',
  'Expansion',
  'Collection No.',
  'Stage (Pokémon)/Type (Energy and Trainer)',
] as const;

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return !trimmed || trimmed.toLowerCase() === 'n/a' ? undefined : trimmed;
}

function classifyCard(stageOrType: string): CardKind {
  const normalized = stageOrType.toLowerCase();
  if (normalized.includes('pokémon') || normalized.includes('pokemon')) return 'pokemon';
  if (normalized.includes('energy')) return 'energy';
  if (
    normalized.includes('trainer') ||
    ['item', 'supporter', 'stadium', 'tool'].some((x) => normalized.includes(x))
  ) {
    return 'trainer';
  }
  throw new PtcgDataError(`unknown card stage/type: ${stageOrType}`);
}

export function loadCardDataCsv(text: string): Map<number, PtcgCard> {
  const rows = parseCsv(text);
  if (rows.length < 2)
    throw new PtcgDataError('card CSV must contain a header and at least one data row');
  const header = rows[0].map((value) => value.trim());
  const column = new Map(header.map((name, index) => [name, index]));
  for (const required of REQUIRED_COLUMNS) {
    if (!column.has(required))
      throw new PtcgDataError(`card CSV is missing required column: ${required}`);
  }
  const get = (row: string[], name: string): string => row[column.get(name) ?? -1] ?? '';
  const cards = new Map<number, PtcgCard>();
  rows.slice(1).forEach((row, offset) => {
    const rowNumber = offset + 2;
    const idText = get(row, 'Card ID').trim();
    const id = Number(idText);
    const name = get(row, 'Card Name').trim();
    const stageOrType = get(row, 'Stage (Pokémon)/Type (Energy and Trainer)').trim();
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new PtcgDataError(`row ${rowNumber}: Card ID must be a positive integer`);
    if (!name) throw new PtcgDataError(`row ${rowNumber}: Card Name is required`);
    if (!stageOrType) throw new PtcgDataError(`row ${rowNumber}: stage/type is required`);
    const hpText = optional(get(row, 'HP'));
    const retreatText = optional(get(row, 'Retreat'));
    const moveName = optional(get(row, 'Move Name'));
    const move = moveName
      ? {
          name: moveName,
          cost: optional(get(row, 'Cost')),
          damage: optional(get(row, 'Damage')),
          effect: optional(get(row, 'Effect Explanation')),
        }
      : undefined;
    const existing = cards.get(id);
    if (existing) {
      if (existing.name !== name || existing.stageOrType !== stageOrType) {
        throw new PtcgDataError(`row ${rowNumber}: Card ID ${id} has inconsistent duplicate rows`);
      }
      if (move) existing.moves.push(move);
      return;
    }
    if (hpText && (!Number.isSafeInteger(Number(hpText)) || Number(hpText) <= 0)) {
      throw new PtcgDataError(`row ${rowNumber}: HP must be a positive integer`);
    }
    if (retreatText && (!Number.isSafeInteger(Number(retreatText)) || Number(retreatText) < 0)) {
      throw new PtcgDataError(`row ${rowNumber}: Retreat must be a non-negative integer`);
    }
    cards.set(id, {
      id,
      name,
      expansion: get(row, 'Expansion').trim(),
      collectionNumber: get(row, 'Collection No.').trim(),
      stageOrType,
      kind: classifyCard(stageOrType),
      rule: optional(get(row, 'Rule')),
      category: optional(get(row, 'Category')),
      previousStage: optional(get(row, 'Previous stage')),
      hp: hpText ? Number(hpText) : undefined,
      type: optional(get(row, 'Type')),
      weakness: optional(get(row, 'Weakness')),
      resistance: optional(get(row, 'Resistance (Type)')),
      retreat: retreatText ? Number(retreatText) : undefined,
      moves: move ? [move] : [],
    });
  });
  return cards;
}

export function loadCardDataFile(path: string): Map<number, PtcgCard> {
  try {
    return loadCardDataCsv(fs.readFileSync(path, 'utf8'));
  } catch (error) {
    if (error instanceof PtcgDataError) throw error;
    throw new PtcgDataError(`unable to read card data ${path}: ${(error as Error).message}`);
  }
}

export function loadDeckCsv(text: string): number[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.map((line, index) => {
    if (!/^\d+$/.test(line) || Number(line) <= 0 || !Number.isSafeInteger(Number(line))) {
      throw new PtcgDataError(`deck row ${index + 1}: expected a positive integer card ID`);
    }
    return Number(line);
  });
}

export function validateDeck(
  deck: readonly number[],
  cards: ReadonlyMap<number, PtcgCard>,
  rules: Readonly<DeckRules> = KAGGLE_DECK_RULES
): DeckValidationResult {
  const errors: string[] = [];
  if (deck.length !== rules.deckSize)
    errors.push(`deck must contain exactly ${rules.deckSize} cards (got ${deck.length})`);
  const byName = new Map<string, number>();
  let aceSpec = 0;
  let basicPokemon = 0;
  deck.forEach((id) => {
    const card = cards.get(id);
    if (!card) {
      errors.push(`unknown card ID: ${id}`);
      return;
    }
    if (card.rule?.toUpperCase() === 'ACE SPEC') aceSpec += 1;
    if (card.kind === 'pokemon' && /^basic\s+(pokémon|pokemon)$/i.test(card.stageOrType))
      basicPokemon += 1;
    if (!/^basic energy$/i.test(card.stageOrType))
      byName.set(card.name, (byName.get(card.name) ?? 0) + 1);
  });
  for (const [name, count] of byName) {
    if (count > rules.maxCopiesByName)
      errors.push(`${name} exceeds the ${rules.maxCopiesByName}-copy limit (${count})`);
  }
  if (aceSpec > rules.maxAceSpec)
    errors.push(`ACE SPEC exceeds the ${rules.maxAceSpec}-card limit (${aceSpec})`);
  if (rules.requireBasicPokemon && basicPokemon === 0)
    errors.push('deck must contain at least one Basic Pokémon');
  return { legal: errors.length === 0, errors };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateLegalDeckCandidates(options: {
  cards: ReadonlyMap<number, PtcgCard>;
  seed: number;
  count: number;
  rules?: Readonly<DeckRules>;
}): number[][] {
  const { cards, count } = options;
  const rules = options.rules ?? KAGGLE_DECK_RULES;
  if (!Number.isSafeInteger(options.seed)) throw new PtcgDataError('seed must be an integer');
  if (!Number.isSafeInteger(count) || count < 0)
    throw new PtcgDataError('candidate count must be a non-negative integer');
  const basicPokemon = [...cards.values()].filter(
    (card) => card.kind === 'pokemon' && /^basic\s+(pokémon|pokemon)$/i.test(card.stageOrType)
  );
  if (rules.requireBasicPokemon && basicPokemon.length === 0)
    throw new PtcgDataError('card pool has no Basic Pokémon');
  const pool = [...cards.values()].sort((a, b) => a.id - b.id);
  if (pool.length === 0) throw new PtcgDataError('card pool is empty');
  const random = mulberry32(options.seed);
  const candidates: number[][] = [];
  for (let candidateIndex = 0; candidateIndex < count; candidateIndex += 1) {
    const deck: number[] = [];
    const names = new Map<string, number>();
    let aceSpec = 0;
    if (rules.requireBasicPokemon) {
      const first = basicPokemon[Math.floor(random() * basicPokemon.length)];
      deck.push(first.id);
      names.set(first.name, 1);
      if (first.rule?.toUpperCase() === 'ACE SPEC') aceSpec += 1;
    }
    let attempts = 0;
    const maxAttempts = Math.max(10_000, rules.deckSize * pool.length * 10);
    while (deck.length < rules.deckSize && attempts < maxAttempts) {
      attempts += 1;
      const card = pool[Math.floor(random() * pool.length)];
      const isBasicEnergy = /^basic energy$/i.test(card.stageOrType);
      const nameCount = names.get(card.name) ?? 0;
      const isAce = card.rule?.toUpperCase() === 'ACE SPEC';
      if (
        (!isBasicEnergy && nameCount >= rules.maxCopiesByName) ||
        (isAce && aceSpec >= rules.maxAceSpec)
      )
        continue;
      deck.push(card.id);
      if (!isBasicEnergy) names.set(card.name, nameCount + 1);
      if (isAce) aceSpec += 1;
    }
    if (deck.length !== rules.deckSize)
      throw new PtcgDataError('card pool cannot satisfy the configured deck rules');
    deck.sort((a, b) => a - b);
    const result = validateDeck(deck, cards, rules);
    if (!result.legal)
      throw new PtcgDataError(`generated an illegal deck: ${result.errors.join('; ')}`);
    candidates.push(deck);
  }
  return candidates;
}
