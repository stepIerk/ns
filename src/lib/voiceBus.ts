// Шина эксклюзивного проигрывания: звучит только одно голосовое за раз.
// Каждый VoiceBubble подписывается; кто начал играть — гасит остальных.

let activeId: string | null = null;
const listeners = new Set<() => void>();

export function getActiveVoiceId(): string | null {
  return activeId;
}

export function setActiveVoiceId(id: string | null): void {
  if (activeId === id) return;
  activeId = id;
  listeners.forEach((l) => {
    try {
      l();
    } catch {
      // ignore
    }
  });
}

export function subscribeVoiceBus(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
