import type {ImageAttachmentRef, PreparedImageAttachment} from '../types/chat';
import {createId} from './formatters';

export const MAX_IMAGES_PER_MESSAGE = 3;
const MAX_RAW_FILE_BYTES = 18 * 1024 * 1024;
const MAX_OUTPUT_DIMENSION = 1600;
const MAX_COMPRESSED_BYTES = 1_400_000;
const THUMBNAIL_MAX_DIMENSION = 240;

const DB_NAME = 'lumen_media_v1';
const DB_VERSION = 1;
const STORE_NAME = 'images';

export interface StoredImageRecord {
  id: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  dataUrl: string;
  base64: string;
  width: number;
  height: number;
  size: number;
}

const memoryFallbackStore = new Map<string, StoredImageRecord>();

function normalizeImageMimeType(
  file: File
): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  const lowerType = file.type.toLowerCase();
  if (lowerType === 'image/jpeg' || lowerType === 'image/jpg') return 'image/jpeg';
  if (lowerType === 'image/png') return 'image/png';
  if (lowerType === 'image/webp') return 'image/webp';

  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) return 'image/jpeg';
  if (lowerName.endsWith('.png')) return 'image/png';
  if (lowerName.endsWith('.webp')) return 'image/webp';
  return null;
}

function loadImageElement(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error(`Unable to read "${file.name}". Please choose a valid JPG, PNG, or WEBP image.`));
    };
    img.src = objectUrl;
  });
}

function canvasToDataUrl(
  canvas: HTMLCanvasElement,
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp',
  quality?: number
): string {
  return canvas.toDataURL(mimeType, quality);
}

function estimateBase64Bytes(dataUrl: string): number {
  const commaIdx = dataUrl.indexOf(',');
  const b64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
  return Math.floor((b64.length * 3) / 4);
}

export async function prepareImageAttachment(
  file: File
): Promise<PreparedImageAttachment> {
  const detectedMime = normalizeImageMimeType(file);
  if (!detectedMime) {
    throw new Error(
      `Unsupported image format (${file.name || file.type || 'unknown'}). Please upload JPG, JPEG, PNG, or WEBP.`
    );
  }

  if (file.size > MAX_RAW_FILE_BYTES) {
    throw new Error(
      `"${file.name}" is larger than 18 MB. Please select a smaller image.`
    );
  }

  const img = await loadImageElement(file);
  const srcWidth = img.naturalWidth || img.width;
  const srcHeight = img.naturalHeight || img.height;

  if (!srcWidth || !srcHeight) {
    throw new Error(`"${file.name}" appears to be empty or corrupted.`);
  }

  const scale = Math.min(1, MAX_OUTPUT_DIMENSION / Math.max(srcWidth, srcHeight));
  const outWidth = Math.max(1, Math.round(srcWidth * scale));
  const outHeight = Math.max(1, Math.round(srcHeight * scale));

  const mainCanvas = document.createElement('canvas');
  mainCanvas.width = outWidth;
  mainCanvas.height = outHeight;
  const mainCtx = mainCanvas.getContext('2d');
  if (!mainCtx) {
    throw new Error('Browser canvas is unavailable for image processing.');
  }
  mainCtx.drawImage(img, 0, 0, outWidth, outHeight);

  let targetMime: 'image/jpeg' | 'image/png' | 'image/webp' = detectedMime;
  let dataUrl = '';

  if (targetMime === 'image/png') {
    dataUrl = canvasToDataUrl(mainCanvas, 'image/png');
    if (estimateBase64Bytes(dataUrl) > MAX_COMPRESSED_BYTES) {
      // Convert oversized PNG screenshots/photos to high-quality WEBP/JPEG for fast Vercel upload
      targetMime = 'image/webp';
      dataUrl = canvasToDataUrl(mainCanvas, 'image/webp', 0.88);
      if (!dataUrl.startsWith('data:image/webp')) {
        targetMime = 'image/jpeg';
        dataUrl = canvasToDataUrl(mainCanvas, 'image/jpeg', 0.88);
      }
    }
  } else {
    let quality = 0.86;
    dataUrl = canvasToDataUrl(mainCanvas, targetMime, quality);
    if (!dataUrl.startsWith(`data:${targetMime}`)) {
      targetMime = 'image/jpeg';
      dataUrl = canvasToDataUrl(mainCanvas, 'image/jpeg', quality);
    }
    while (estimateBase64Bytes(dataUrl) > MAX_COMPRESSED_BYTES && quality > 0.55) {
      quality -= 0.12;
      dataUrl = canvasToDataUrl(mainCanvas, targetMime, quality);
    }
  }

  const commaIdx = dataUrl.indexOf(',');
  const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
  const finalSize = estimateBase64Bytes(dataUrl);

  // Create lightweight thumbnail (~4-8 KB) for instant Local Storage rendering
  const thumbScale = Math.min(1, THUMBNAIL_MAX_DIMENSION / Math.max(outWidth, outHeight));
  const thumbWidth = Math.max(1, Math.round(outWidth * thumbScale));
  const thumbHeight = Math.max(1, Math.round(outHeight * thumbScale));
  const thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = thumbWidth;
  thumbCanvas.height = thumbHeight;
  const thumbCtx = thumbCanvas.getContext('2d');
  let thumbnailDataUrl = dataUrl;
  if (thumbCtx) {
    thumbCtx.drawImage(mainCanvas, 0, 0, thumbWidth, thumbHeight);
    thumbnailDataUrl = canvasToDataUrl(thumbCanvas, 'image/jpeg', 0.72);
  }

  return {
    id: createId(),
    name: file.name || 'image',
    mimeType: targetMime,
    size: finalSize,
    width: outWidth,
    height: outHeight,
    thumbnailDataUrl,
    base64,
    dataUrl,
  };
}

export function stripPreparedToRef(
  attachment: PreparedImageAttachment
): ImageAttachmentRef {
  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    width: attachment.width,
    height: attachment.height,
    thumbnailDataUrl: attachment.thumbnailDataUrl,
  };
}

function openMediaDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !('indexedDB' in window)) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = window.indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, {keyPath: 'id'});
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'));
  });
}

export async function saveImageRecord(
  attachment: PreparedImageAttachment
): Promise<void> {
  const record: StoredImageRecord = {
    id: attachment.id,
    mimeType: attachment.mimeType,
    dataUrl: attachment.dataUrl,
    base64: attachment.base64,
    width: attachment.width,
    height: attachment.height,
    size: attachment.size,
  };
  memoryFallbackStore.set(attachment.id, record);

  try {
    const db = await openMediaDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(record);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  } catch {
    // Keep memoryFallbackStore active if IndexedDB is restricted
  }
}

export async function getImageRecord(id: string): Promise<StoredImageRecord | null> {
  const cached = memoryFallbackStore.get(id);
  if (cached) return cached;

  try {
    const db = await openMediaDb();
    return await new Promise<StoredImageRecord | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(id);
      req.onsuccess = () => {
        const result = (req.result as StoredImageRecord | undefined) ?? null;
        if (result) {
          memoryFallbackStore.set(id, result);
        }
        db.close();
        resolve(result);
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
  } catch {
    return null;
  }
}

export async function deleteImageRecords(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  for (const id of ids) {
    memoryFallbackStore.delete(id);
  }
  try {
    const db = await openMediaDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const id of ids) {
        store.delete(id);
      }
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  } catch {
    // Ignore cleanup errors
  }
}

export async function clearAllImageRecords(): Promise<void> {
  memoryFallbackStore.clear();
  try {
    const db = await openMediaDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  } catch {
    // Ignore cleanup errors
  }
}
