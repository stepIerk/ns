// Кружочки (видео до минуты): запись через MediaRecorder (видео+аудио).
// Кроп в круг — ТОЛЬКО CSS на фронте (настройка формы локальна),
// в Drive лежит обычный прямоугольник.
// Цепочка как у голосовых: record → encryptBytes → upload-init → чанки →
// setDoc media → addDoc kind:'video' → push.

export const MAX_VIDEO_MS = 60 * 1000; // автостоп, кружок максимум минута
export const MIN_VIDEO_MS = 1000; // короче — «слишком короткий», не шлём
// Диета записи: кружки смотрят на 210–350px, поэтому 480p + ~0.9 Мбит/с
// хватает за глаза, а файл выходит в разы меньше (типичные 5–15с ≈ 0.5–1.7МБ
// вместо 5–15МБ сырого 1080p). Меньше файл — меньше чанков гнать/качать.
export const VIDEO_BITS_PER_SECOND = 900_000;
export const AUDIO_BITS_PER_SECOND = 48_000;
// Размер решает судьбу кружка: и отправка, и приём режут на 10 МБ
// (MAX_PHOTO_BYTES), а битрейт-кап поддерживают не все (WebKit пишет на
// своих ~10 Мбит/с — константа LargeVideoBitRate в его исходниках).
// Поэтому стопим запись по фактическим чанкам: софт-бюджет оставляет
// место финальному куску, жёсткий — потолок для хвоста на всякий случай.
export const MAX_VIDEO_BYTES = 8.5 * 1024 * 1024;
export const MAX_VIDEO_FILE_BYTES = 9.9 * 1024 * 1024;

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
      width: { ideal: 480 },
      height: { ideal: 480 },
    },
    audio: true,
  };
}
