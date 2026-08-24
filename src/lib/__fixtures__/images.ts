// Real, minimal image files built byte by byte, so the validator is tested against actual
// file structures rather than mocks of them. Every one of these parses in a browser.

import { deflateSync } from "node:zlib";

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A valid 8-bit RGB PNG of the given size, filled with one colour. */
export function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  // 10..12 = compression, filter, interlace — all 0

  // One filter byte (0 = none) plus 3 bytes per pixel, per row.
  const raw = Buffer.alloc(height * (1 + width * 3));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A GIF89a with two frames and a Netscape looping block — a genuinely ANIMATED gif. */
export function animatedGif(width: number, height: number): Buffer {
  const screen = Buffer.alloc(7);
  screen.writeUInt16LE(width, 0);
  screen.writeUInt16LE(height, 2);
  screen[4] = 0xf0; // global colour table, 2 entries
  screen[5] = 0; // background colour index
  screen[6] = 0; // pixel aspect ratio

  const palette = Buffer.from([0x00, 0x00, 0x00, 0xff, 0xff, 0xff]);
  // NETSCAPE2.0 application extension — "loop forever". Its presence is what makes this an
  // animation rather than a still image, and is exactly what a re-encode would strip.
  const loop = Buffer.concat([
    Buffer.from([0x21, 0xff, 0x0b]),
    Buffer.from("NETSCAPE2.0", "latin1"),
    Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00]),
  ]);

  const frame = (colorIndex: number) =>
    Buffer.concat([
      // Graphic control extension: 10ms delay
      Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00]),
      // Image descriptor at 0,0 covering the whole screen
      (() => {
        const d = Buffer.alloc(10);
        d[0] = 0x2c;
        d.writeUInt16LE(0, 1);
        d.writeUInt16LE(0, 3);
        d.writeUInt16LE(width, 5);
        d.writeUInt16LE(height, 7);
        d[9] = 0;
        return d;
      })(),
      // Minimal LZW stream: clear, one colour run, end, terminator
      Buffer.from([0x02, 0x02, 0x4c === colorIndex ? 0x4c : 0x44, 0x01, 0x00]),
    ]);

  return Buffer.concat([
    Buffer.from("GIF89a", "latin1"),
    screen,
    palette,
    loop,
    frame(0),
    frame(1),
    Buffer.from([0x3b]),
  ]);
}

/** A baseline JPEG: SOI, APP0/JFIF, SOF0 carrying the dimensions, then EOI. */
export function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.concat([
    Buffer.from([0xff, 0xe0, 0x00, 0x10]),
    Buffer.from("JFIF\0", "latin1"),
    Buffer.from([0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
  ]);
  const sof0 = Buffer.alloc(19);
  sof0.writeUInt16BE(0xffc0, 0);
  sof0.writeUInt16BE(17, 2); // segment length
  sof0[4] = 8; // precision
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  sof0[9] = 3; // three components
  for (let c = 0; c < 3; c++) {
    sof0[10 + c * 3] = c + 1;
    sof0[11 + c * 3] = 0x11;
    sof0[12 + c * 3] = 0;
  }
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app0,
    sof0,
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** A lossy (VP8) WebP — the RIFF container plus a VP8 bitstream header. */
export function webp(width: number, height: number): Buffer {
  const vp8 = Buffer.alloc(20);
  // 3-byte frame tag: key frame, version 0, show_frame 1, and a partition size.
  vp8[0] = 0x50;
  vp8[1] = 0x00;
  vp8[2] = 0x00;
  // Start code 0x9d 0x01 0x2a, then 14-bit width and height.
  vp8[3] = 0x9d;
  vp8[4] = 0x01;
  vp8[5] = 0x2a;
  vp8.writeUInt16LE(width & 0x3fff, 6);
  vp8.writeUInt16LE(height & 0x3fff, 8);

  const chunk = Buffer.concat([
    Buffer.from("VP8 ", "latin1"),
    (() => {
      const len = Buffer.alloc(4);
      len.writeUInt32LE(vp8.length);
      return len;
    })(),
    vp8,
  ]);

  const riffSize = Buffer.alloc(4);
  riffSize.writeUInt32LE(4 + chunk.length);
  return Buffer.concat([
    Buffer.from("RIFF", "latin1"),
    riffSize,
    Buffer.from("WEBP", "latin1"),
    chunk,
  ]);
}
