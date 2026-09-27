/**
 * Font metrics of the diagram fonts for text measurement without a browser (Node.js, CI).
 *
 * The diagram uses Helvetica (or the metric compatible Arial / Liberation Sans) for names and labels
 * and a monospace font for the definition section. The widths below are the advance widths of the
 * standard Helvetica AFM file (Adobe Core 14 fonts) in 1/1000 em.
 */

/** Advance widths of the printable ASCII characters (32 – 126) of Helvetica in 1/1000 em. */
const HELVETICA_ASCII: readonly number[] = [
    // space ! " # $ % & ' ( ) * + , - . /
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    // 0 - 9
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
    // : ; < = > ? @
    278, 278, 584, 584, 584, 556, 1015,
    // A - Z
    667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833,
    722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
    // [ \ ] ^ _ `
    278, 278, 278, 469, 556, 333,
    // a - z
    556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833,
    556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500,
    // { | } ~
    334, 260, 334, 584
];

/** Widths of some non-ASCII characters used in diagrams (Helvetica / Arial). */
const HELVETICA_EXTRA: Record<string, number> = {
    ' ': 278, // no-break space
    '…': 1000,
    '–': 556,
    '—': 1000,
    '→': 1000,
    '←': 1000,
    '•': 350,
    '·': 278,
    '×': 584,
    '°': 400,
    'ä': 556, 'ö': 556, 'ü': 556, 'Ä': 667, 'Ö': 778, 'Ü': 722, 'ß': 611, 'é': 556, 'è': 556, 'à': 556
};

/** Width of other characters (average width of the lower case letters). */
const HELVETICA_DEFAULT = 556;

/** Advance width of every character of monospace fonts (DejaVu Sans Mono, Menlo, Liberation Mono: 0.6 em). */
export const MONOSPACE_ADVANCE = 602;

/** Width of a text in Helvetica at the given font size (in px). */
export function helveticaTextWidth(text: string, fontSize: number): number {
    let units = 0;
    for (const char of text) {
        const code = char.codePointAt(0)!;
        if (code >= 32 && code <= 126) {
            units += HELVETICA_ASCII[code - 32];
        } else {
            units += HELVETICA_EXTRA[char] ?? (code < 32 ? 0 : HELVETICA_DEFAULT);
        }
    }
    return units * fontSize / 1000;
}

/** Width of a text in a monospace font at the given font size (in px). */
export function monospaceTextWidth(text: string, fontSize: number): number {
    let count = 0;
    for (const _char of text) {
        count++;
    }
    return count * MONOSPACE_ADVANCE * fontSize / 1000;
}
