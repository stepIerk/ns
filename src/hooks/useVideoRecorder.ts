import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AUDIO_BITS_PER_SECOND,
  MAX_VIDEO_BYTES,
  MAX_VIDEO_FILE_BYTES,
  MAX_VIDEO_MS,
  VIDEO_BITS_PER_SECOND,
  pickVideoMime,
  videoConstraints,
  type VideoFacing,
} from '../lib/video';

export interface VideoTake {
  blob: Blob;
  mime: string;
  recordedMs: number;
  /** Автостоп по бюджету размера (браузер проигнорировал битрейт-кап). */
  truncated?: boolean;
}

export type VideoPhase = 'idle' | 'holding' | 'locked';

// Страховка стопа: WebKit с timeslice умеет не прислать onstop на длинных
// mp4 — через паузу сами гасим треки и отдаём то, что накопили.
const STOP_FALLBACK_MS = 2500;

/**
 * Ядро записи кружочков (жесты — в композере, как у голосовых):
 * getUserMedia (видео+аудио) → MediaRecorder → чанки; стрим отдаём наружу
 * для живого превью. Тикает только таймер.
 *
 * start(onDone) → {ok, message?}. finish(true) — отправить, finish(false) —
 * выкинуть. Автостоп по MAX_VIDEO_MS и по бюджету MAX_VIDEO_BYTES (браузер
 * может игнорировать битрейт и раздуть файл сверх лимита отправки в 10 МБ).
 * lock() — holding → locked.
 *
 * Завершение — ТОЛЬКО через finalize(): он гасит треки и отдаёт take ровно
 * один раз, кем бы ни был вызван — stop(), ошибкой рекордера, концом треков
 * или страховочным таймером. Раньше всё висело на rec.onstop, назначенном в
 * момент стопа: если браузер не слал onstop (Safari на длинных записях) —
 * камера продолжала гореть, а кружок молча терялся.
 *
 * flip() — переворот камеры ПРЯМО во время записи: видеотрек меняется в том же
 * объекте MediaStream (рекордер продолжает писать — так умеет Chrome; Safari
 * может дать чёрный кусок — принимаем как best-effort). Аудиотрек не трогаем.
 * Если запись остановили, пока открывалась вторая камера, её треки гасим.
 */
export function useVideoRecorder() {
  const [phase, setPhase] = useState<VideoPhase>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [facing, setFacing] = useState<VideoFacing>('user');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const mimeRef = useRef('');
  const doneRef = useRef<((take: VideoTake | null) => void) | null>(null);
  const finishedRef = useRef(false);
  const finishRef = useRef<(send: boolean) => void>(() => {});
  const finalizeRef = useRef<() => void>(() => {});
  const finalizedRef = useRef(false);
  const pendingSendRef = useRef<boolean | null>(null);
  const recordedMsRef = useRef(0);
  const recordedBytesRef = useRef(0);
  const truncatedRef = useRef(false);
  const stopFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const facingRef = useRef<VideoFacing>('user');
  // Номер записи: «запоздалые» события старого рекордера (onstop/onerror уже
  // после стопа) не должны финализировать новую запись.
  const recGenRef = useRef(0);
  // Старт в процессе (getUserMedia на iOS включается 1–3с) и намерение
  // отпущенного пальца: если finish пришёл раньше готовности камеры —
  // запоминаем его и применяем сразу после старта (иначе запись «зависает»).
  const startingRef = useRef(false);
  const pendingFinishRef = useRef<boolean | null>(null);

  const teardown = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (stopFallbackRef.current) {
      clearTimeout(stopFallbackRef.current);
      stopFallbackRef.current = null;
    }
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
    setStream(null);
  }, []);

  // Размонтирование: запись не переживает чат — гасим камеру и запрещаем
  // «дозревать» take уже после ухода со страницы.
  useEffect(
    () => () => {
      finalizedRef.current = true;
      teardown();
    },
    [teardown],
  );

  // Единственная точка финала: треки гасим и отдаём take ровно раз. send не
  // задан (естественный конец/ошибка) — отдаём то, что успели записать.
  const finalize = useCallback(() => {
    if (finalizedRef.current) return;
    finalizedRef.current = true;
    if (stopFallbackRef.current) {
      clearTimeout(stopFallbackRef.current);
      stopFallbackRef.current = null;
    }
    const send = pendingSendRef.current !== false;
    const recordedMs = recordedMsRef.current || Date.now() - startedAtRef.current;
    const mime = mimeRef.current;
    const done = doneRef.current;
    setPhase('idle');
    teardown();
    doneRef.current = null;
    if (!done) return;
    if (!send) {
      chunksRef.current = [];
      done(null);
      return;
    }
    const parts = chunksRef.current;
    let blob = new Blob(parts, { type: mime });
    // Последний кусок мог оказаться сильно больше timeslice (или их вовсе
    // нет) — подрезаем хвост, чтобы файл не пробил лимит отправки.
    while (blob.size > MAX_VIDEO_FILE_BYTES && parts.length > 1) {
      truncatedRef.current = true;
      parts.pop();
      blob = new Blob(parts, { type: mime });
    }
    chunksRef.current = [];
    done({ blob, mime, recordedMs, truncated: truncatedRef.current });
  }, [teardown]);

  useEffect(() => {
    finalizeRef.current = finalize;
  }, [finalize]);

  const start = useCallback(
    async (onDone: (take: VideoTake | null) => void): Promise<{ ok: boolean; message?: string }> => {
      if (recRef.current || startingRef.current) {
        return { ok: false, message: 'Камера ещё включается — попробуй ещё раз' };
      }
      if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        return { ok: false, message: 'Браузер не умеет записывать видео' };
      }
      const mime = pickVideoMime();
      if (!mime) return { ok: false, message: 'Браузер не умеет записывать видео' };
      startingRef.current = true;
      pendingFinishRef.current = null;
      const gen = ++recGenRef.current;
      finishedRef.current = false; // до ответа камеры — «идёт старт», не «финиш прошлой записи»
      finalizedRef.current = false;
      pendingSendRef.current = null;
      recordedMsRef.current = 0;
      recordedBytesRef.current = 0;
      truncatedRef.current = false;
      try {
        facingRef.current = 'user';
        setFacing('user');
        let st: MediaStream;
        try {
          st = await navigator.mediaDevices.getUserMedia(videoConstraints('user'));
        } catch {
          return { ok: false, message: 'Нет доступа к камере — разреши в настройках' };
        }
        let rec: MediaRecorder;
        try {
          // Битрейт капаем (см. lib/video): у кого не поддерживается — упадёт
          // в catch и запишем без капа (файл больше, но работает везде).
          rec = new MediaRecorder(st, {
            mimeType: mime,
            videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
            audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
          });
        } catch {
          try {
            rec = new MediaRecorder(st, { mimeType: mime });
          } catch {
            st.getTracks().forEach((t) => t.stop());
            return { ok: false, message: 'Не удалось начать запись' };
          }
        }
        chunksRef.current = [];
        doneRef.current = onDone;
        mimeRef.current = rec.mimeType || mime;
        streamRef.current = st;
        recRef.current = rec;
        startedAtRef.current = Date.now();
        rec.ondataavailable = (e) => {
          if (recGenRef.current !== gen) return;
          if (e.data && e.data.size > 0) {
            chunksRef.current.push(e.data);
            recordedBytesRef.current += e.data.size;
            // Битрейт-кап поддерживают не все (WebKit пишет на своих ~10
            // Мбит/с) — режем по фактическому размеру, чтобы кружок уехал.
            if (recordedBytesRef.current >= MAX_VIDEO_BYTES) {
              truncatedRef.current = true;
              finishRef.current(true);
            }
          }
        };
        // Обработчики ставим ДО старта: рекордер может встать сам (ошибка,
        // кончились треки) — финализируем и тогда, не теряя запись.
        rec.onstop = () => {
          if (recGenRef.current !== gen) return;
          finalizeRef.current();
        };
        rec.onerror = () => {
          if (recGenRef.current !== gen) return;
          finalizeRef.current();
        };
        rec.start(1000);
        setStream(st);
        setElapsedMs(0);
        setPhase('holding');
        timerRef.current = setInterval(() => {
          const el = Date.now() - startedAtRef.current;
          setElapsedMs(el);
          if (el >= MAX_VIDEO_MS) finishRef.current(true);
        }, 200);
        // Палец отпущен (или жест отменён), пока камера ещё включалась:
        // применяем отложенный finish — вместо «самоиграющейся» записи.
        const pending = pendingFinishRef.current;
        if (pending != null) {
          pendingFinishRef.current = null;
          finishRef.current(pending);
        }
        return { ok: true };
      } finally {
        startingRef.current = false;
      }
    },
    [],
  );

  const finish = useCallback((send: boolean) => {
    const rec = recRef.current;
    if (finishedRef.current) return;
    if (!rec) {
      // Старт ещё не завершился — запомним намерение (см. start()).
      if (startingRef.current) pendingFinishRef.current = send;
      return;
    }
    finishedRef.current = true;
    pendingSendRef.current = send;
    recordedMsRef.current = Date.now() - startedAtRef.current;
    setPhase('idle');
    // Рекордер мог встать сам (ошибка/треки кончились): stop() на inactive
    // по спеке молчит и событий не шлёт — финализируем без него.
    if (rec.state === 'inactive') {
      finalizeRef.current();
      return;
    }
    try {
      rec.stop();
    } catch {
      finalizeRef.current();
      return;
    }
    // Страховка: если onstop так и не придёт — через паузу сами гасим
    // треки и отдаём накопленные чанки.
    stopFallbackRef.current = setTimeout(() => {
      stopFallbackRef.current = null;
      finalizeRef.current();
    }, STOP_FALLBACK_MS);
  }, []);

  useEffect(() => {
    finishRef.current = finish;
  }, [finish]);

  const lock = useCallback(() => {
    setPhase((p) => (p === 'holding' ? 'locked' : p));
  }, []);

  const cancel = useCallback(() => {
    finish(false);
  }, [finish]);

  const flip = useCallback(async (): Promise<{ ok: boolean; message?: string }> => {
    const rec = recRef.current;
    const st = streamRef.current;
    if (!rec || !st || rec.state !== 'recording') return { ok: false };
    const next: VideoFacing = facingRef.current === 'user' ? 'environment' : 'user';
    // Сначала строго (exact) — чтобы точно сменить камеру, потом мягко (ideal).
    let tmp: MediaStream | null = null;
    for (const mode of [{ exact: next }, next] as const) {
      try {
        tmp = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: mode, width: { ideal: 480 }, height: { ideal: 480 } },
          audio: false,
        });
        break;
      } catch {
        tmp = null;
      }
    }
    if (!tmp) return { ok: false, message: 'Не вышло перевернуть камеру' };
    // Пока открывалась вторая камера, запись могли остановить: её треки
    // больше никто не погасит (teardown уже прошёл) — не выпускаем их.
    if (recRef.current !== rec || streamRef.current !== st) {
      tmp.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
          // ignore
        }
      });
      return { ok: false, message: 'Запись уже завершена' };
    }
    const [newTrack] = tmp.getVideoTracks();
    if (!newTrack) {
      tmp.getTracks().forEach((t) => t.stop());
      return { ok: false, message: 'Не вышло перевернуть камеру' };
    }
    const oldTrack = st.getVideoTracks()[0];
    try {
      if (oldTrack) {
        st.removeTrack(oldTrack);
        try {
          oldTrack.stop();
        } catch {
          // ignore
        }
      }
      st.addTrack(newTrack);
      tmp.getTracks().forEach((t) => {
        if (t !== newTrack) {
          try {
            t.stop();
          } catch {
            // ignore
          }
        }
      });
    } catch {
      try {
        newTrack.stop();
      } catch {
        // ignore
      }
      tmp.getTracks().forEach((t) => t.stop());
      return { ok: false, message: 'Не вышло перевернуть камеру' };
    }
    facingRef.current = next;
    setFacing(next);
    return { ok: true };
  }, []);

  return { phase, elapsedMs, facing, stream, start, finish, lock, cancel, flip };
}
