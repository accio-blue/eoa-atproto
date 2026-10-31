import { Option, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { ImageRecordSchema } from './image.js';
import { ImageValueSchema } from './defs.js';

/** A blob as the record carries one. */
const BLOB = {
  $type: 'blob',
  ref: { $link: 'bafkreif4vo72pi6ydmkax3yyqyfoknfk4qccz5ea7jlrxuyz62ls325ise' },
  mimeType: 'image/jpeg',
  size: 425533,
};

const record = (value: unknown) =>
  Option.isSome(Schema.decodeUnknownOption(ImageRecordSchema)(value));

const imageValue = (value: unknown) =>
  Option.isSome(Schema.decodeUnknownOption(ImageValueSchema)(value));

describe('the image sidecar', () => {
  it('holds the bytes and everything derived from them', () => {
    // What kocharin's imageRef carried, in one record of its own: the picture,
    // its size, the colour the box is painted with, the palette, the
    // placeholder and the resized copies.
    expect(
      record({
        ref: BLOB,
        width: 1200,
        height: 1600,
        dominantColor: '#1b1b1f',
        palette: ['#112233', '#aabbcc'],
        thumbhash: '1QcSHQRnh493V4dIh4eXh1h4kJUI',
        variants: [
          { width: 480 },
          { width: 860, url: 'https://img.example/860.webp' },
          { width: 1920, ref: BLOB },
        ],
        createdAt: '2026-10-13T00:00:00.000Z',
      }),
    ).toBe(true);

    // The bytes are what the record is for: without them there is no image.
    expect(record({ createdAt: '2026-10-13T00:00:00.000Z' })).toBe(false);

    // A variant without its width is not a variant.
    expect(
      record({
        ref: BLOB,
        variants: [{ url: 'https://img.example/x.webp' }],
        createdAt: '2026-10-13T00:00:00.000Z',
      }),
    ).toBe(false);
  });

  it('lets a document point at the sidecar instead of repeating it', () => {
    // The alt text stays with the value: it is per-locale prose, not a fact
    // about the picture — and the same picture in another language is the same
    // bytes.
    expect(
      imageValue({
        ref: BLOB,
        alt: 'Арлекин',
        meta: {
          uri: 'at://did:plc:5itbtooiegem6wyg3rq5ukf4/ing.lexicon.cms.image/3abc',
          cid: 'bafyreiftdy6k75z3lobo5d56d2dhccclu2otdryy4bythf63pwulhlgv2m',
        },
      }),
    ).toBe(true);

    // And a value that keeps everything itself still fits: the sidecar is an
    // option, not a requirement.
    expect(imageValue({ ref: BLOB, palette: ['#112233'] })).toBe(true);
  });
});
