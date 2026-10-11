// Big emoji как в TG — чисто фронт, в доки/IDB ничего не пишем.
// Сообщение только из смайлов (пробелы/переносы не считаются):
//   1–2 смайла → 'huge', 3+ → 'mid', иначе null (обычный пузырь).
//
// Невидимые символы сравниваем по кодпоинтам (не литералами/эскейпами):
// VS16, ZWJ (цепочки типа семья), KEYCAP (1 + KEYCAP = 1 в круге).

const VS16 = 0xfe0f;
const ZWJ = 0x200d;
const KEYCAP = 0x20e3;

// Ядро смайла: сам знак (флаги — regional indicators — тоже ядро).
const EMOJI_CORE = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u;
// Один знак внутри графемы: ядро + скин-тон, остальное разбираем по кодпоинтам.
const EMOJI_SIGN = /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}]/u;

function containsKeycap(s: string): boolean {
  for (const ch of s) {
    if ((ch.codePointAt(0) ?? 0) === KEYCAP) return true;
  }
  return false;
}

function isEmojiGrapheme(g: string): boolean {
  if (!EMOJI_CORE.test(g) && !containsKeycap(g)) return false;
  for (const ch of g) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === VS16 || cp === ZWJ || cp === KEYCAP) continue;
    if (ch === '#' || ch === '*' || (ch >= '0' && ch <= '9')) continue;
    if (!EMOJI_SIGN.test(ch)) return false;
  }
  return true;
}

let segmenter: { segment(s: string): Iterable<{ segment: string }> } | null | undefined;

function getSegmenter() {
  if (segmenter !== undefined) return segmenter;
  try {
    const Ctor = (Intl as unknown as {
      Segmenter?: new (locale: string, opts: { granularity: string }) => {
        segment(s: string): Iterable<{ segment: string }>;
      };
    }).Segmenter;
    segmenter = Ctor ? new Ctor('und', { granularity: 'grapheme' }) : null;
  } catch {
    segmenter = null;
  }
  return segmenter;
}

export function bigEmojiKind(text: string | undefined): 'huge' | 'mid' | null {
  if (!text) return null;
  const stripped = text.replace(/\s/g, '');
  if (!stripped) return null;
  // Быстрый выход: ядра смайла нет вообще — обычный текст, дальше не разбираем.
  if (!EMOJI_CORE.test(stripped) && !containsKeycap(stripped)) return null;
  let graphemes: string[];
  const seg = getSegmenter();
  if (seg) {
    graphemes = [...seg.segment(stripped)].map((s) => s.segment);
  } else {
    // Древние браузеры: бьём по кодпоинтам (ZWJ-цепочки пересчитаются в 'mid').
    graphemes = Array.from(stripped);
  }
  if (graphemes.length === 0) return null;
  for (const g of graphemes) {
    if (!isEmojiGrapheme(g)) return null;
  }
  return graphemes.length <= 2 ? 'huge' : 'mid';
}
