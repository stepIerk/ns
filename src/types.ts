export type MessageKind = 'text' | 'photo' | 'voice';

/** Цель ответа: ссылка на родительское сообщение (см. ChatMessage.replyTo). */
export interface ReplyTarget {
  id: string;
  clientMessageId?: string;
  senderId: string;
}

export interface ChatMessage {
  id: string; // firestore doc id, или local-... для optimistic
  clientMessageId: string;
  senderId: string;
  createdAtMs: number;
  kind: MessageKind;
  // расшифрованный текст (только локально, никогда не пишем в Firestore)
  text?: string;
  decryptError?: boolean;
  // photo — за флагом ENABLE_MEDIA (v1 только читаем как заглушку)
  mediaId?: string;
  objectKey?: string; // legacy B2 (старые сообщения)
  driveFileId?: string; // Google Drive (новый флоу)
  mimeType?: string;
  size?: number;
  iv?: string;
  // voice: длительность и огибающая для waveform (plaintext-метадата, не секрет).
  durationMs?: number;
  waveform?: number[];
  // Ответ (цитата): только ссылка на родителя, сниппет резолвится локально
  // по id (затем по clientMessageId — покрывает pending-родителя после эха).
  replyTo?: ReplyTarget;
  // spark: сообщение-салют (эмодзи из spark-пикера). Флаг plaintext,
  // анимация — только фронт (первый просмотр получателя, флаг в IDB).
  spark?: boolean;
  // статусы: только локальные. read = пир отрендерил (seenTs из RTDB presence).
  status: 'sending' | 'sent' | 'read' | 'error';
  pending?: boolean;
  errorText?: string;
}

export interface MessageDoc {
  clientMessageId: string;
  senderId: string;
  createdAt: unknown; // serverTimestamp
  clientTs: number;
  kind: MessageKind;
  ciphertext?: string; // base64, text
  iv?: string; // base64, text + photo
  mediaId?: string;
  objectKey?: string; // legacy B2
  driveFileId?: string; // Google Drive
  mimeType?: string;
  size?: number;
  // voice
  durationMs?: number;
  waveform?: number[];
  // Ответ: ссылка на родителя (опционально, старые доки без неё валидны).
  replyToId?: string;
  replyToSenderId?: string;
  replyToClientId?: string;
  // spark-салют (только true; см. ChatMessage.spark)
  spark?: boolean;
  // receipts за флагом ENABLE_RECEIPTS (v1 не пишем/не читаем)
  deliveredAt?: unknown;
  readAt?: unknown;
}

export interface MediaDoc {
  messageId: string;
  objectKey?: string; // legacy B2
  driveFileId?: string; // Google Drive
  size: number; // размер ciphertext
  mimeType: string;
  iv: string;
  senderId: string;
  createdAt: unknown;
}
