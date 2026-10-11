// Spark Emoji: салюты для возлюбленных. Чисто фронт: сообщение несёт только
// флаг spark:true, эффект выводится из текста, первый просмотр — флаг в IDB.
// Бэк (функция, правила) не трогаем вообще.

export type SparkEffect = 'hearts' | 'kisses' | 'confetti' | 'rain';

export interface SparkItem {
  emoji: string;
  effect: SparkEffect;
}

// Пикер сердечка: ровно 4 spark — тап = мгновенная отправка.
export const SPARK_SET: SparkItem[] = [
  { emoji: '❤️', effect: 'hearts' },
  { emoji: '😘', effect: 'kisses' },
  { emoji: '🥳', effect: 'confetti' },
  { emoji: '😭', effect: 'rain' },
];

const EFFECT_BY_EMOJI = new Map<string, SparkEffect>(SPARK_SET.map((s) => [s.emoji, s.effect]));

// Дополнительные глифы частиц (первый — всегда сам отправленный эмодзи).
// Сердца — только красные, слёзы — в основном капли.
const EFFECT_EXTRAS: Record<SparkEffect, string[]> = {
  hearts: ['❤️', '❤️', '❤️'],
  kisses: ['💋', '😘', '💋'],
  confetti: ['🎉', '🎊', '✨', '🥳'],
  rain: ['💧', '💧', '💦', '💧', '😭'],
};

export const SPARK_DURATION_MS = 2800;

/** Эффект по тексту сообщения (первый графем). Не spark-набор → 'hearts'. */
export function effectFor(text: string | undefined): SparkEffect {
  if (!text) return 'hearts';
  let first = text;
  try {
    const Ctor = (Intl as unknown as {
      Segmenter?: new (locale: string, opts: { granularity: string }) => {
        segment(s: string): Iterable<{ segment: string }>;
      };
    }).Segmenter;
    if (Ctor) {
      const it = new Ctor('und', { granularity: 'grapheme' }).segment(text);
      const next = it[Symbol.iterator]().next();
      if (!next.done) first = next.value.segment;
    } else {
      first = Array.from(text)[0] ?? text;
    }
  } catch {
    // ignore — first уже весь текст
  }
  return EFFECT_BY_EMOJI.get(first) ?? 'hearts';
}

/** Глифы частиц: отправленный первым, дальше — хвост эффекта. */
export function sparkGlyphs(sentEmoji: string, effect: SparkEffect): string[] {
  return [sentEmoji, ...EFFECT_EXTRAS[effect]];
}

export interface SparkParticle {
  glyph: string;
  left: number; // % ширины
  top: number; // % высоты (только pop-появление)
  size: number; // px
  duration: number; // ms
  delay: number; // ms
  drift: number; // px по горизонтали
  spin: number; // deg
}

/** Детерминированный разброс без Math.random в рендере: seeded PRNG. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sparkParticles(sentEmoji: string, effect: SparkEffect, seed: number): SparkParticle[] {
  const glyphs = sparkGlyphs(sentEmoji, effect);
  const rnd = mulberry(seed);
  const out: SparkParticle[] = [];
  // hearts: плотный поток больших красных сердец снизу на весь экран.
  // kisses: большие поцелуи вспыхивают по всему экрану с задержками.
  // confetti: падение сверху со sway. rain: частые капли сверху.
  const count = effect === 'kisses' ? 30 : effect === 'hearts' ? 48 : effect === 'rain' ? 48 : 40;
  for (let i = 0; i < count; i += 1) {
    const glyph = glyphs[i % glyphs.length] ?? sentEmoji;
    if (effect === 'hearts') {
      out.push({
        glyph,
        left: rnd() * 100,
        top: 0,
        size: 180 + rnd() * 100,
        // Быстрый поток: весь путь (+25vh → −120vh) за ~1–1.5с.
        duration: 900 + rnd() * 600,
        // Поток на всю жизнь оверлея: старты размазаны, хвост режет fade-out.
        delay: rnd() * 2000,
        drift: (rnd() - 0.5) * 120,
        spin: (rnd() - 0.5) * 120,
      });
      continue;
    }
    if (effect === 'kisses') {
      // Только 💋, большие.
      out.push({
        glyph: '💋',
        left: 4 + rnd() * 92,
        top: 4 + rnd() * 88,
        size: 150 + rnd() * 80,
        duration: 2000 + rnd() * 600,
        delay: rnd() * 1400,
        drift: 0,
        spin: (rnd() - 0.5) * 40,
      });
      continue;
    }
    const fast = effect === 'rain';
    out.push({
      glyph,
      left: rnd() * 100,
      top: 0,
      size: fast ? 52 + rnd() * 48 : 36 + rnd() * 36,
      duration: fast ? 1200 + rnd() * 800 : 1800 + rnd() * 900,
      delay: rnd() * (fast ? 800 : 500),
      drift: fast ? (rnd() - 0.5) * 40 : (rnd() - 0.5) * 160,
      spin: (rnd() - 0.5) * 360,
    });
  }
  return out;
}
