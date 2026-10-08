// Уменьшение фото перед шифрованием: мессенджеру не нужны 12Мп оригиналы,
// а прокси-скачивание чанками тем быстрее, чем меньше файл.
// PNG с прозрачностью превращается в JPEG (фон станет чёрным) — приемлемо для MVP.
export async function prepareImage(
  file: File,
  maxDim = 1600,
  quality = 0.85,
): Promise<{ bytes: ArrayBuffer; mime: string }> {
  const orig = await file.arrayBuffer();
  try {
    if (typeof createImageBitmap !== 'function') return { bytes: orig, mime: file.type };
    const bmp = await createImageBitmap(new Blob([orig], { type: file.type }));
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    // Маленькие JPEG не пережимаем — отдаём оригинал.
    if (scale >= 1 && (file.type === 'image/jpeg' || file.type === 'image/webp')) {
      bmp.close();
      return { bytes: orig, mime: file.type };
    }
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bmp.close();
      return { bytes: orig, mime: file.type };
    }
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', quality),
    );
    if (!blob) return { bytes: orig, mime: file.type };
    const small = await blob.arrayBuffer();
    // Сжатый вышел больше оригинала — оставляем оригинал.
    if (small.byteLength >= orig.byteLength) return { bytes: orig, mime: file.type };
    return { bytes: small, mime: 'image/jpeg' };
  } catch {
    return { bytes: orig, mime: file.type };
  }
}
