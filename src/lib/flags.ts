// Фиче-флаги: медиа (фото через Drive) включено.
// Receipts (галочки прочтения) включены через RTDB seenTs: пишет пир при рендере,
// читаем чужое поле — свой rooms-листенер не триггерим, loop невозможен.
export const ENABLE_MEDIA = true;
export const ENABLE_RECEIPTS = true;
