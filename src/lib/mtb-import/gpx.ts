// Full-fidelity GPX reader for the curated MTB import. READ-ONLY: it looks at the bytes of a
// source file and never writes one back. The original file is what riders download; what this
// produces is only the input to the simplifier that builds the stored display geometry.
//
// Handles what the 1009 curated files actually contain: one or several <trk> elements (26 files
// have a main line plus small extra pieces), one or several <trkseg> per <trk> (11 files), points
// with and without <ele> (50 files carry none at all), self-closing points, and a <rte> fallback.
// Nothing is dropped: every valid point of every track/segment is returned, in document order.

export interface GpxPoint {
  lat: number;
  lng: number;
  /** Metres, or null when this point had no readable <ele>. Never invented. */
  ele: number | null;
}

export interface GpxPart {
  /** Which <trk> (or the lone <rte>) this part came from, 0-based, in document order. */
  track: number;
  /** Which <trkseg> inside that track, 0-based. */
  segment: number;
  /** Index into the concatenated `points` where this part starts. */
  start: number;
  count: number;
}

export interface ParsedGpx {
  /** Every valid point of every part, concatenated in document order. */
  points: GpxPoint[];
  parts: GpxPart[];
}

const NUMBER = /^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/;

function attr(tag: string, name: string): number | null {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`));
  if (!match || !NUMBER.test(match[1].trim())) return null;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : null;
}

/** Points inside one block of XML — <trkpt>/<rtept>, open/close or self-closing. */
function readPoints(block: string, tagName: "trkpt" | "rtept"): GpxPoint[] {
  const points: GpxPoint[] = [];
  const re = new RegExp(`<${tagName}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${tagName}>)`, "g");
  for (const match of block.matchAll(re)) {
    const lat = attr(match[1], "lat");
    const lng = attr(match[1], "lon");
    if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    let ele: number | null = null;
    const eleMatch = match[2]?.match(/<ele>\s*([^<]*?)\s*<\/ele>/);
    if (eleMatch && NUMBER.test(eleMatch[1])) {
      const value = Number.parseFloat(eleMatch[1]);
      ele = Number.isFinite(value) ? value : null;
    }
    points.push({ lat, lng, ele });
  }
  return points;
}

export function parseGpx(text: string): ParsedGpx {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const points: GpxPoint[] = [];
  const parts: GpxPart[] = [];

  const add = (track: number, segment: number, found: GpxPoint[]) => {
    if (found.length === 0) return;
    parts.push({ track, segment, start: points.length, count: found.length });
    for (const point of found) points.push(point);
  };

  const tracks = [...source.matchAll(/<trk\b[^>]*>([\s\S]*?)<\/trk>/g)];
  tracks.forEach((trk, trackIndex) => {
    const segments = [...trk[1].matchAll(/<trkseg\b[^>]*>([\s\S]*?)<\/trkseg>/g)];
    if (segments.length === 0) {
      add(trackIndex, 0, readPoints(trk[1], "trkpt"));
      return;
    }
    segments.forEach((seg, segIndex) => add(trackIndex, segIndex, readPoints(seg[1], "trkpt")));
  });

  // A file with no <trk> at all but a planned <rte> is still a route worth keeping.
  if (points.length === 0) {
    const routes = [...source.matchAll(/<rte\b[^>]*>([\s\S]*?)<\/rte>/g)];
    routes.forEach((rte, i) => add(i, 0, readPoints(rte[1], "rtept")));
  }

  return { points, parts };
}
