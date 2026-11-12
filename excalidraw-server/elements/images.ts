/**
 * Intranet fork (I3): which of a scene's images the server may rasterize.
 * resvg decodes an image at its full size, whatever size it is shown at:
 * a small file can claim a huge picture (a 400 KB PNG of 20 000 × 20 000
 * pixels unpacks to 1.6 GB). The size stands in the file's first bytes.
 */

/** largest picture the PNG renderer unpacks (4096 × 4096) */
export const MAX_IMAGE_PIXELS = 4096 * 4096;
/** largest SVG image drawn into a PNG */
const MAX_SVG_IMAGE_BYTES = 5 * 1024 * 1024;

const RASTER_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

interface Size {
  width: number;
  height: number;
}

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u24le = (b: Uint8Array, i: number) =>
  b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b: Uint8Array, i: number) =>
  ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
const ascii = (b: Uint8Array, i: number, length: number) =>
  String.fromCharCode(...b.subarray(i, i + length));

const jpegSize = (b: Uint8Array): Size | null => {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      return null;
    }
    const marker = b[i + 1];
    // fill bytes and markers without a length
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const length = u16be(b, i + 2);
    // a frame header (SOF0 to SOF15, not DHT, JPG or DAC) has the size
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      return { height: u16be(b, i + 5), width: u16be(b, i + 7) };
    }
    if (length < 2) {
      return null;
    }
    i += 2 + length;
  }
  return null;
};

/** a raster image's size from its first bytes, or null (unknown, broken) */
export const rasterSize = (b: Uint8Array): Size | null => {
  if (
    b.length >= 24 &&
    ascii(b, 1, 3) === "PNG" &&
    ascii(b, 12, 4) === "IHDR"
  ) {
    return { width: u32be(b, 16), height: u32be(b, 20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    return jpegSize(b);
  }
  if (b.length >= 10 && ascii(b, 0, 4) === "GIF8") {
    let size: Size = { width: u16le(b, 6), height: u16le(b, 8) };
    // the first frame may claim more than the screen it sits on
    let i = 13;
    if (b[10] & 0x80) {
      i += 3 * 2 ** ((b[10] & 0x07) + 1);
    }
    while (i < b.length) {
      if (b[i] === 0x2c && i + 9 < b.length) {
        size = {
          width: Math.max(size.width, u16le(b, i + 1) + u16le(b, i + 5)),
          height: Math.max(size.height, u16le(b, i + 3) + u16le(b, i + 7)),
        };
        break;
      }
      if (b[i] !== 0x21) {
        break;
      }
      // an extension: label, then sub-blocks until an empty one
      i += 2;
      while (i < b.length && b[i] !== 0) {
        i += b[i] + 1;
      }
      i++;
    }
    return size;
  }
  if (
    b.length >= 30 &&
    ascii(b, 0, 4) === "RIFF" &&
    ascii(b, 8, 4) === "WEBP"
  ) {
    const chunk = ascii(b, 12, 4);
    if (chunk === "VP8X") {
      return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
    }
    if (chunk === "VP8 ") {
      return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    }
    if (chunk === "VP8L" && b[20] === 0x2f) {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
      };
    }
  }
  return null;
};

const decodeDataUrl = (
  dataURL: string,
): { type: string; bytes: Uint8Array } | null => {
  const match = /^data:([a-z0-9.+/-]+)((?:;[^;,]*)*?)(;base64)?,/i.exec(
    dataURL,
  );
  if (!match) {
    return null;
  }
  const payload = dataURL.slice(match[0].length);
  try {
    const bytes = match[3]
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf8");
    return { type: match[1].toLowerCase(), bytes: new Uint8Array(bytes) };
  } catch {
    return null;
  }
};

const rasterFits = (bytes: Uint8Array) => {
  const size = rasterSize(bytes);
  return (
    !!size &&
    size.width > 0 &&
    size.height > 0 &&
    size.width * size.height <= MAX_IMAGE_PIXELS
  );
};

/**
 * May this image (a data URL) go into a PNG? Raster pictures up to
 * MAX_IMAGE_PIXELS; SVG pictures if every picture inside them fits, too.
 */
export const imageFitsPng = (dataURL: string): boolean => {
  const decoded = decodeDataUrl(dataURL);
  if (!decoded) {
    return false;
  }
  if (RASTER_TYPES.includes(decoded.type)) {
    return rasterFits(decoded.bytes);
  }
  if (decoded.type === "image/svg+xml") {
    if (decoded.bytes.length > MAX_SVG_IMAGE_BYTES) {
      return false;
    }
    const text = Buffer.from(decoded.bytes).toString("utf8");
    for (const match of text.matchAll(
      /data:image\/[a-z0-9.+-]+(?:;[^;,"')\s]*)*,[^"')\s]*/gi,
    )) {
      if (!imageFitsPng(match[0])) {
        return false;
      }
    }
    return true;
  }
  return false;
};

/** only pictures embedded in the scene: nothing that points elsewhere */
export const isEmbeddedImage = (dataURL: unknown): dataURL is string =>
  typeof dataURL === "string" && /^data:image\/[a-z0-9.+-]+[;,]/i.test(dataURL);
