// Фиче-флаги: медиа (фото через Drive) включено, read-receipts выключены.
// Receipts (deliveredAt/readAt) не включаем: записи внутри onSnapshot дают
// loop "snapshot -> write -> snapshot" и flood Write/channel.
export const ENABLE_MEDIA = true;
export const ENABLE_RECEIPTS = false;
