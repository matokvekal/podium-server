// Free-text track search — turning what a rider typed into match groups for
// selectPublicEvents (queries/event.queries.ts). No AI: plain tokens, a few hand-written
// synonyms, and pg_trgm for typos on the SQL side.
//
// THE MODEL. A query becomes a list of GROUPS, one per word typed. A row matches when EVERY group
// matches (so "יער צרעה" and "צרעה יער" are the same search), and a group matches when ANY of its
// alternatives is found in the row's searchable text — as a substring (partial words: "צרע"
// finds "צרעה") or, in SQL, by trigram word similarity (typos: "jerusalm").
//
// ALTERNATIVES are what make Hebrew and English meet. routes.ai_search_text (sql/057) labels its
// structured facts in English ("Season: winter and spring", "Activity: mountain bike (MTB)") while
// riders search in Hebrew, so "חורף" also tries "winter" and "שטח" also tries "mtb". Region names
// need nothing here: the text already carries both ("Region: Jerusalem / ירושלים").
//
// HEBREW PREFIXES. "ביער" / "וירושלים" glue a one-letter preposition or conjunction onto the
// word. Substring matching already finds "יער" inside "ביער" in the TEXT; for the same prefix in
// the QUERY, the word without its first letter is tried too — but only at the START of a word
// (marked WORD_START below). As a plain substring, "מצדה" → "צדה" turned up inside unrelated
// words.

/** Typed words beyond this are ignored — a pasted paragraph is not a search. */
export const MAX_SEARCH_GROUPS = 8;

/** Below this many characters a word is never fuzzy-matched: 2-3 letter trigram scores are noise. */
export const FUZZY_MIN_CHARS = 4;

/** An alternative starting with this must match at the start of a word, not anywhere inside
 *  one. Safe as a marker: tokens are split on every non-letter/digit, so none contains it. */
export const WORD_START = "^";

/** Leading letters a Hebrew word may carry as a prefix (ו ה ב ל מ ש כ). */
const HEBREW_PREFIXES = new Set(["ו", "ה", "ב", "ל", "מ", "ש", "כ"]);

/** Hebrew ↔ the English words routes.ai_search_text uses for the same structured fact. Kept to
 *  vocabulary that text actually contains (see lib/route-search-text.ts), both directions. */
const SYNONYM_SETS: readonly (readonly string[])[] = [
  ["שטח", "mtb", "mountain bike"],
  ["כביש", "road"],
  ["גרבל", "גראבל", "גראוול", "gravel"],
  ["ריצה", "running"],
  ["הליכה", "טיול", "hiking"],
  ["חורף", "winter"],
  ["אביב", "spring"],
  ["סתיו", "autumn"],
  ["קיץ", "summer"],
  ["מוצל", "צל", "shaded", "shade"],
  ["חשוף", "exposed"],
  ["קל", "easy"],
  ["בינוני", "moderate"],
  ["קשה", "hard"],
  ["מאתגר", "challenging"],
  ["נגיש", "accessible"],
];

const SYNONYMS = new Map<string, readonly string[]>();
for (const set of SYNONYM_SETS) for (const word of set) SYNONYMS.set(word, set);

/**
 * A score for one route from an OPTIONAL ranking layer (services/trackSearch.service.ts) — e.g. a
 * future semantic / vector similarity between the query and the route's ai_search_text. 0..1.
 *
 * A boost only RE-ORDERS rows the lexical search already matched; it never adds a row, never
 * removes one, and never touches the filters or the response shape. A route with no boost
 * simply ranks on its lexical score, exactly as with no ranking layer at all.
 */
export interface RouteBoost {
  routeId: number;
  score: number;
}

/** Boosts beyond this are dropped — it is one bound JSON parameter, not a table. */
export const MAX_ROUTE_BOOSTS = 500;

export interface TrackSearch {
  /** The words, lower-cased, joined by one space — for exact / prefix name ranking. */
  phrase: string;
  /** One group per word; a row must match every group, any alternative within it. */
  groups: string[][];
  /** Optional extra ranking signal; absent today. See RouteBoost. */
  boosts?: RouteBoost[];
}

/**
 * null when nothing searchable remains (empty, or only punctuation / one-letter words) — the
 * caller then keeps its old plain-substring behaviour for that input.
 */
export function buildTrackSearch(q: string | null | undefined): TrackSearch | null {
  if (typeof q !== "string") return null;
  // Letters and digits in any script; everything else (punctuation, dashes, quotes) separates.
  // Splitting on these also means no token can carry a LIKE wildcard (% or _).
  const words = q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2);
  const unique = [...new Set(words)].slice(0, MAX_SEARCH_GROUPS);
  if (unique.length === 0) return null;

  const groups = unique.map((word) => {
    const alternatives = new Set<string>([word]);
    for (const syn of SYNONYMS.get(word) ?? []) alternatives.add(syn);
    if (word.length >= 4 && HEBREW_PREFIXES.has(word[0])) {
      const bare = word.slice(1);
      alternatives.add(WORD_START + bare);
      for (const syn of SYNONYMS.get(bare) ?? []) alternatives.add(syn);
    }
    return [...alternatives];
  });
  return { phrase: unique.join(" "), groups };
}
