import { useCallback, useEffect, useRef, useState } from 'react';
import { LIVE_BARS, MAX_VOICE_MS, pickVoiceMime } from '../lib/voice';

export interface VoiceTake {
  blob: Blob;
  mime: string;
  recordedMs: number;
}

export type RecPhase = 'idle' | 'holding' | 'locked';

/**
 * Ядро записи голосовых (жесты слайдов — в композере, здесь только железо):
 * getUserMedia → MediaRecorder → чанки; живой уровень через AnalyserNode
 * пишется напрямую в DOM полосок (ref, без ререндеров); тикает только таймер.
 *
 * start(onDone) → true/false (false — нет микрофона/прав/поддержки, текст в msg).
 * finish(send) — собрать take (send=true) или выкинуть (false). Автостоп по MAX.
 * lock() — holding → locked (палец можно отпускать).
 */
export function useVoiceRecorder() {
  const [phase, setPhase] = useState<RecPhase>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const mimeRef = useRef('');
  const doneRef = useRef<((take: VoiceTake | null) => void) | null>(null);
  const finishedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const rafRef = useRef(0);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const barsElRef = useRef<HTMLElement | null>(null);
  const levelsRef = useRef<number[]>([]);
  const finishRef = useRef<(send: boolean) => void>(() => {});

  const teardown = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    cancelAnimationFrame(rafRef.current);
    try {
      audioCtxRef.current?.close().catch(() => {});
    } catch {
      // ignore
    }
    audioCtxRef.current = null;
    analyserRef.current = null;
    const st = streamRef.current;
    streamRef.current = null;
    st?.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        // ignore
      }
    });
    recRef.current = null;
  }, []);

  useEffect(() => teardown, [teardown]);

  const setBarsEl = useCallback((el: HTMLElement | null) => {
    barsElRef.current = el;
    levelsRef.current = [];
  }, []);

  // Живой уровень: RMS кадра → история последних LIVE_BARS → высоты спанов.
  // Самореференс через ref (как pump в useMedia) — иначе хук-линт ругается.
  const pumpRef = useRef(() => {});
  const pumpLevels = useCallback(() => {
    const an = analyserRef.current;
    const el = barsElRef.current;
    if (an && el) {
      const buf = new Uint8Array(an.fftSize);
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i += 1) {
        const v = (buf[i] ?? 128) - 128;
        sum += v * v;
      }
      const rms = Math.min(1, Math.sqrt(sum / buf.length) / 40);
      const lv = levelsRef.current;
      lv.push(rms);
      if (lv.length > LIVE_BARS) lv.shift();
      const kids = el.children;
      for (let i = 0; i < kids.length; i += 1) {
        const k = kids[i] as HTMLElement | undefined;
        if (!k) continue;
        // История справа налево: свежий уровень — крайний правый.
        const v = lv[lv.length - kids.length + i] ?? 0;
        k.style.height = `${Math.round(18 + Math.min(1, v * 1.6) * 82)}%`;
      }
    }
    rafRef.current = requestAnimationFrame(pumpRef.current);
  }, []);

  useEffect(() => {
    pumpRef.current = pumpLevels;
  }, [pumpLevels]);

  const start = useCallback(
    async (onDone: (take: VoiceTake | null) => void): Promise<{ ok: boolean; message?: string }> => {
      if (recRef.current) return { ok: false };
      if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        return { ok: false, message: 'Браузер не умеет записывать звук' };
      }
      const mime = pickVoiceMime();
      if (!mime) return { ok: false, message: 'Браузер не умеет записывать звук' };
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        return { ok: false, message: 'Нет доступа к микрофону — разреши в настройках' };
      }
      let rec: MediaRecorder;
      try {
        rec = new MediaRecorder(stream, { mimeType: mime });
      } catch {
        stream.getTracks().forEach((t) => t.stop());
        return { ok: false, message: 'Не удалось начать запись' };
      }
      chunksRef.current = [];
      finishedRef.current = false;
      doneRef.current = onDone;
      mimeRef.current = rec.mimeType || mime;
      streamRef.current = stream;
      recRef.current = rec;
      startedAtRef.current = Date.now();
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.start(250);
      // Анализатор для живого индикатора (тихо падает — запись продолжится).
      try {
        const AC =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (AC) {
          const actx = new AC();
          const src = actx.createMediaStreamSource(stream);
          const an = actx.createAnalyser();
          an.fftSize = 512;
          src.connect(an);
          audioCtxRef.current = actx;
          analyserRef.current = an;
        }
      } catch {
        // ignore
      }
      setElapsedMs(0);
      setPhase('holding');
      timerRef.current = setInterval(() => {
        const el = Date.now() - startedAtRef.current;
        setElapsedMs(el);
        if (el >= MAX_VOICE_MS) void finishRef.current?.(true);
      }, 200);
      rafRef.current = requestAnimationFrame(pumpLevels);
      return { ok: true };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pumpLevels, teardown],
  );

  const finish = useCallback(
    (send: boolean) => {
      const rec = recRef.current;
      const done = doneRef.current;
      if (!rec || !done || finishedRef.current) return;
      finishedRef.current = true;
      const recordedMs = Date.now() - startedAtRef.current;
      const mime = mimeRef.current;
      setPhase('idle');
      rec.onstop = () => {
        teardown();
        if (!send) {
          done(null);
          return;
        }
        const blob = new Blob(chunksRef.current, { type: mime });
        chunksRef.current = [];
        done({ blob, mime, recordedMs });
      };
      try {
        rec.stop();
      } catch {
        teardown();
        done(null);
      }
    },
    [teardown],
  );

  // Для автостопа из таймера (актуальный finish без пересоздания start).
  useEffect(() => {
    finishRef.current = finish;
  }, [finish]);

  const lock = useCallback(() => {
    setPhase((p) => (p === 'holding' ? 'locked' : p));
  }, []);

  const cancel = useCallback(() => {
    finish(false);
  }, [finish]);

  return { phase, elapsedMs, start, finish, lock, cancel, setBarsEl };
}
