import { useEffect, useMemo, useRef } from 'react';
import {
  SPARK_DURATION_MS,
  sparkParticles,
  type SparkEffect,
} from '../lib/spark';

interface Props {
  emoji: string;
  effect: SparkEffect;
  seed: number;
  onDone: () => void;
}

function motionOf(effect: SparkEffect): 'sp-rise' | 'sp-pop' | 'sp-fall-sway' | 'sp-fall-fast' {
  if (effect === 'kisses') return 'sp-pop';
  if (effect === 'confetti') return 'sp-fall-sway';
  if (effect === 'rain') return 'sp-fall-fast';
  return 'sp-rise';
}

/**
 * Салют на весь экран: только анимация частиц, без центральной иконки.
 * Нижний бар (композер, z 70) — поверх салюта (z 60). Тап — пропустить.
 */
export default function SparkOverlay({ emoji, effect, seed, onDone }: Props) {
  const doneRef = useRef(onDone);
  useEffect(() => {
    doneRef.current = onDone;
  });
  const reduced =
    typeof matchMedia !== 'undefined' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches;
  const particles = useMemo(
    () => (reduced ? [] : sparkParticles(emoji, effect, seed)),
    [emoji, effect, seed, reduced],
  );

  useEffect(() => {
    try {
      navigator.vibrate?.(30);
    } catch {
      // ignore (iOS)
    }
    const t = setTimeout(() => doneRef.current(), reduced ? 1200 : SPARK_DURATION_MS);
    return () => clearTimeout(t);
  }, [reduced]);

  return (
    <div
      className="spark-overlay"
      role="status"
      aria-label="Салют"
      onClick={() => doneRef.current()}
    >
      {particles.map((p, i) => (
        <span
          key={`${p.glyph}-${i}`}
          className={`spark-p ${motionOf(effect)}`}
          aria-hidden
          style={
            {
              left: `${p.left}%`,
              top: effect === 'kisses' ? `${p.top}%` : undefined,
              fontSize: `${p.size}px`,
              animationDuration: `${p.duration}ms`,
              animationDelay: `${p.delay}ms`,
              '--dx': `${p.drift}px`,
              '--rot': `${p.spin}deg`,
            } as React.CSSProperties
          }
        >
          {p.glyph}
        </span>
      ))}
    </div>
  );
}
