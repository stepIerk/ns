import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AUDIO_BITS_PER_SECOND,
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
}

export type VideoPhase = 'idle' | 'holding' | 'locked';

/**
 * Ядро записи кружочков (жесты — в композере, как у голосовых):
 * getUserMedia (видео+аудио) → MediaRecorder → чанки; стрим отдаём наружу
 * для живого превью. Тикает только таймер.
 *
 * start(onDone) → {ok, message?}. finish(true) — отправить, finish(false) —
 * выкинуть. Автостоп по MAX_VIDEO_MS. lock() — holding → locked.
 *
 * flip() — переворот камеры ПРЯМО во время записи: видеотрек меняется в том же
 * объекте MediaStream (рекордер продолжает писать — так умеет Chrome; Safari
 * может дать чёрный кусок — принимаем как best-effort). Аудиотрек не трогаем.
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
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const facingRef = useRef<VideoFacing>('user');

  const teardown = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
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

  useEffect(() => teardown, [teardown]);

  const start = useCallback(
    async (onDone: (take: VideoTake | null) => void): Promise<{ ok: boolean; message?: string }> => {
      if (recRef.current) return { ok: false };
      if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        return { ok: false, message: 'Браузер не умеет записывать видео' };
      }
      const mime = pickVideoMime();
      if (!mime) return { ok: false, message: 'Браузер не умеет записывать видео' };
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
      finishedRef.current = false;
      doneRef.current = onDone;
      mimeRef.current = rec.mimeType || mime;
      streamRef.current = st;
      recRef.current = rec;
      startedAtRef.current = Date.now();
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
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
      return { ok: true };
    },
    [],
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
    const st = streamRef.current;
    if (!recRef.current || !st) return { ok: false };
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
