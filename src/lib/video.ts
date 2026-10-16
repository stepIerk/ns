// Кружочки (видео до минуты): запись через MediaRecorder (видео+аудио).
// Кроп в круг — ТОЛЬКО CSS на фронте (настройка формы локальна),
// в Drive лежит обычный прямоугольник.
// Цепочка как у голосовых: record → encryptBytes → upload-init → чанки →
// setDoc media → addDoc kind:'video' → push.

export const MAX_VIDEO_MS = 60 * 1000; // автостоп, кружок максимум минута
export const MIN_VIDEO_MS = 1000; // короче — «слишком короткий», не шлём

export type VideoFacing = 'user' | 'environment'; // фронталка / основная

/**
 * Первый поддерживаемый mime. mp4 первым: его играют и iOS, и Chrome.
 * webm на iOS не проиграется — только fallback (та же история, что у звука).
 */
export function pickVideoMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const cands = ['video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
  for (const c of cands) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c;
    } catch {
      // ignore
    }
  }
  return '';
}

export function videoConstraints(facing: VideoFacing): MediaStreamConstraints {
  return {
    video: {
      facingMode: { ideal: facing },
      width: { ideal: 720 },
      height: { ideal: 720 },
    },
    audio: true,
  };
}
