// Голосовые сообщения: запись (MediaRecorder), waveform, шифрование и Drive.
//
// Цепочка как у фото: record → computeVoiceWave → encryptBytes → upload-init
// → N × upload-chunk → setDoc media → addDoc voice-message → push.
// Аудио-байты сервер видит только шифротекстом; durationMs/waveform —
// plaintext-метадата для отрисовки (не секрет).

export const VOICE_BARS = 48; // полосок в waveform пузыря
export const LIVE_BARS = 28; // полосок живого индикатора записи
export const MAX_VOICE_MS = 10 * 60 * 1000; // автостоп записи
export const MIN_VOICE_MS = 500; // короче — «слишком короткое», не шлём
export const HOLD_TO_RECORD_MS = 200; // холд дольше — запись; короче — тап (смена mic/cam)
export const LOCK_DY = -70; // слайд вверх — зафиксировать запись
export const CANCEL_DX = -60; // слайд влево — отмена (корзина подсвечивается)

/**
 * Первый поддерживаемый mime. mp4 первым осознанно: его играют и iOS Safari,
 * и Chrome/Android. webm/opus на iOS не проиграется — только как fallback.
 */
export function pickVoiceMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const cands = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  for (const c of cands) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c;
    } catch {
      // ignore
    }
  }
  return '';
}

export function formatVoiceTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Огибающая из готового blob: декодируем → N корзин → RMS → нормируем 0..1.
 * При неудаче — ровная линия и duration 0 (пузырь покажет время записи).
 */
export async function computeVoiceWave(
  blob: Blob,
  bars = VOICE_BARS,
): Promise<{ waveform: number[]; durationMs: number }> {
  const flat = () => new Array<number>(bars).fill(0.15);
  try {
    const buf = await blob.arrayBuffer();
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return { waveform: flat(), durationMs: 0 };
    const ctx = new AC();
    try {
      const audio = await ctx.decodeAudioData(buf.slice(0));
      const ch = audio.getChannelData(0);
      if (ch.length === 0) return { waveform: flat(), durationMs: 0 };
      const per = Math.max(1, Math.floor(ch.length / bars));
      const step = Math.max(1, Math.floor(per / 64));
      const buckets: number[] = [];
      let peak = 0;
      for (let i = 0; i < bars; i += 1) {
        const start = i * per;
        let sum = 0;
        let n = 0;
        for (let j = start; j < Math.min(start + per, ch.length); j += step) {
          const v = ch[j] ?? 0;
          sum += v * v;
          n += 1;
        }
        const rms = n > 0 ? Math.sqrt(sum / n) : 0;
        buckets.push(rms);
        if (rms > peak) peak = rms;
      }
      return {
        waveform: buckets.map((b) => (peak > 0 ? Math.round((b / peak) * 100) / 100 : 0.15)),
        durationMs: Math.round(audio.duration * 1000),
      };
    } finally {
      ctx.close().catch(() => {});
    }
  } catch {
    return { waveform: flat(), durationMs: 0 };
  }
}
