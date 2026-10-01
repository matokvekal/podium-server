// Cover for turning a typed search into match groups (lib/track-search.ts). What the groups then
// match is SQL (event.queries.ts); these pin down the part that decides WHAT is searched for.

import { describe, expect, it } from "vitest";
import { buildTrackSearch, MAX_SEARCH_GROUPS, WORD_START } from "./track-search.js";

describe("buildTrackSearch", () => {
  it("one word → one group", () => {
    expect(buildTrackSearch("צרעה")).toEqual({ phrase: "צרעה", groups: [["צרעה"]] });
  });

  it("several words → one group each, so every word must match and order does not matter", () => {
    const a = buildTrackSearch("יער צרעה");
    const b = buildTrackSearch("צרעה יער");
    expect(a?.groups).toEqual([["יער"], ["צרעה"]]);
    expect(new Set(a?.groups.flat())).toEqual(new Set(b?.groups.flat()));
  });

  it("lower-cases English and splits on punctuation", () => {
    expect(buildTrackSearch("Jerusalem, GRAVEL!")).toEqual({
      phrase: "jerusalem gravel",
      groups: [["jerusalem"], ["gravel", "גרבל", "גראבל", "גראוול"]],
    });
  });

  it("adds the English word the route text uses for a Hebrew one, and back", () => {
    expect(buildTrackSearch("שטח")?.groups[0]).toEqual(["שטח", "mtb", "mountain bike"]);
    expect(buildTrackSearch("חורף")?.groups[0]).toEqual(["חורף", "winter"]);
    expect(buildTrackSearch("winter")?.groups[0]).toEqual(["winter", "חורף"]);
  });

  it("tries a Hebrew word without its prefix letter — at a word start only", () => {
    expect(buildTrackSearch("ביער")?.groups[0]).toEqual(["ביער", `${WORD_START}יער`]);
    // ...and the stripped word's synonyms too: "בחורף" is "in winter".
    expect(buildTrackSearch("בחורף")?.groups[0]).toEqual([
      "בחורף",
      `${WORD_START}חורף`,
      "חורף",
      "winter",
    ]);
  });

  it("does not strip a prefix from a short word", () => {
    expect(buildTrackSearch("הר")?.groups[0]).toEqual(["הר"]);
    expect(buildTrackSearch("מצד")?.groups[0]).toEqual(["מצד"]);
  });

  it("drops one-letter words, duplicates, and anything past the word limit", () => {
    expect(buildTrackSearch("a נחל נחל")?.groups).toEqual([["נחל"]]);
    const many = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
    expect(buildTrackSearch(many)?.groups).toHaveLength(MAX_SEARCH_GROUPS);
  });

  it("returns null when nothing searchable is left — the caller keeps plain substring search", () => {
    expect(buildTrackSearch(undefined)).toBeNull();
    expect(buildTrackSearch("")).toBeNull();
    expect(buildTrackSearch("  - ! ")).toBeNull();
    expect(buildTrackSearch("x")).toBeNull();
  });

  it("never emits a LIKE wildcard or regex character from user input", () => {
    const tokens = buildTrackSearch("50% off_road (a|b) .* [x] \\d+")?.groups.flat() ?? [];
    for (const t of tokens) expect(t.replace(WORD_START, "")).toMatch(/^[\p{L}\p{N} ]+$/u);
  });
});
