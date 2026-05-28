import {
  INLINE_IMAGE_DATA_URL_PREFIX,
  sanitizeInlineImageDataUrl as sanitizeSharedInlineImageDataUrl,
} from "openclaw/plugin-sdk/inline-image-data-url-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const IMAGE_OMITTED_TEXT = "omitted image payload: invalid inline image data";

function readRecordValue(record: Record<string, unknown>, key: string): unknown {
  try {
    return record[key];
  } catch {
    return undefined;
  }
}

function readableRecordEntries(record: Record<string, unknown>): Array<[string, unknown]> {
  let keys: string[];
  try {
    keys = Object.keys(record);
  } catch {
    return [];
  }
  const entries: Array<[string, unknown]> = [];
  for (const key of keys) {
    try {
      entries.push([key, record[key]]);
    } catch {
      // Mirrored history can include synthetic plugin objects with throwing
      // getters. Drop unreadable fields before image sanitation recurses.
    }
  }
  return entries;
}

function cloneReadableRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(readableRecordEntries(record));
}

function hasOwnReadableKey(record: Record<string, unknown>, key: string): boolean {
  try {
    return Object.hasOwn(record, key);
  } catch {
    return false;
  }
}

export function sanitizeInlineImageDataUrl(imageUrl: string): string | undefined {
  return sanitizeSharedInlineImageDataUrl(imageUrl);
}

export function invalidInlineImageText(label: string): string {
  return `[${label}] ${IMAGE_OMITTED_TEXT}`;
}

function sanitizeImageContentRecord(
  record: Record<string, unknown>,
  label: string,
): Record<string, unknown> | undefined {
  const type = readRecordValue(record, "type");
  if (type === "image") {
    if (!hasOwnReadableKey(record, "data")) {
      return undefined;
    }
    const data = readRecordValue(record, "data");
    if (typeof data !== "string") {
      return { type: "text", text: invalidInlineImageText(label) };
    }
    const rawMimeType = readRecordValue(record, "mimeType");
    const mimeType = typeof rawMimeType === "string" ? rawMimeType : "image/png";
    const imageUrl = sanitizeInlineImageDataUrl(`data:${mimeType};base64,${data}`);
    if (!imageUrl) {
      return { type: "text", text: invalidInlineImageText(label) };
    }
    const commaIndex = imageUrl.indexOf(",");
    const metadata = imageUrl.slice(INLINE_IMAGE_DATA_URL_PREFIX.length, commaIndex);
    const mime = metadata.split(";")[0] ?? mimeType;
    return { ...cloneReadableRecord(record), mimeType: mime, data: imageUrl.slice(commaIndex + 1) };
  }

  const imageUrlValue = readRecordValue(record, "imageUrl");
  if (type === "inputImage") {
    if (typeof imageUrlValue !== "string") {
      return { type: "inputText", text: invalidInlineImageText(label) };
    }
    const imageUrl = sanitizeInlineImageDataUrl(imageUrlValue);
    return imageUrl
      ? { ...cloneReadableRecord(record), imageUrl }
      : { type: "inputText", text: invalidInlineImageText(label) };
  }

  const imageUrlSnakeValue = readRecordValue(record, "image_url");
  if (type === "input_image") {
    if (typeof imageUrlSnakeValue !== "string") {
      return { type: "input_text", text: invalidInlineImageText(label) };
    }
    const imageUrl = sanitizeInlineImageDataUrl(imageUrlSnakeValue);
    return imageUrl
      ? { ...cloneReadableRecord(record), image_url: imageUrl }
      : { type: "input_text", text: invalidInlineImageText(label) };
  }

  return undefined;
}

export function sanitizeCodexHistoryImagePayloads<T>(value: T, label: string): T {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeCodexHistoryImagePayloads(entry, label)) as T;
  }
  if (!isRecord(value)) {
    return value;
  }

  const imageRecord = sanitizeImageContentRecord(value, label);
  if (imageRecord) {
    return imageRecord as T;
  }

  const next: Record<string, unknown> = {};
  for (const [key, child] of readableRecordEntries(value)) {
    next[key] = sanitizeCodexHistoryImagePayloads(child, label);
  }
  return next as T;
}
