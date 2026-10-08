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
  // photo
  mediaId?: string;
  objectKey?: string;
  mimeType?: string;
  size?: number;
  iv?: string;
  // статусы
  status: 'sending' | 'sent' | 'delivered' | 'read' | 'error';
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
  objectKey?: string;
  mimeType?: string;
  size?: number;
  deliveredAt?: unknown;
  readAt?: unknown;
}

export interface MediaDoc {
  messageId: string;
  objectKey: string;
  size: number; // размер ciphertext
  mimeType: string;
  iv: string;
  senderId: string;
  createdAt: unknown;
}
