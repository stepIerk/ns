export type MessageKind = 'text' | 'photo';

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
  // статусы v1: только локальные. delivered/read за флагом ENABLE_RECEIPTS.
  status: 'sending' | 'sent' | 'error';
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
