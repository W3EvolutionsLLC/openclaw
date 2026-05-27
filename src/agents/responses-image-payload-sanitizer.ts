import { sanitizeInlineImageDataUrl as sanitizeSharedInlineImageDataUrl } from "../media/inline-image-data-url.js";
import { isRecord } from "../shared/record-coerce.js";

const IMAGE_OMITTED_TEXT = "omitted image payload: invalid inline image data";
const CIRCULAR_OMITTED_TEXT = "omitted image payload: circular reference";
const NON_JSON_OMITTED_TEXT = "omitted image payload: non-JSON-compatible value";
const UNREADABLE_OMITTED_TEXT = "omitted image payload: unreadable payload";

type JsonRecord = Record<string, unknown>;
type SanitizeContext = "value" | "input-array" | "input-item" | "content-entry";

function invalidSnakeImage(): JsonRecord {
  return omittedPayload(IMAGE_OMITTED_TEXT);
}

function omittedText(text: string): string {
  return `[${text}]`;
}

function omittedPayload(text: string): JsonRecord {
  return { type: "input_text", text: omittedText(text) };
}

function shouldOmitObjectField(value: unknown): boolean {
  return (
    value === undefined ||
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  );
}

function omittedInputItem(text: string): JsonRecord {
  return {
    type: "message",
    role: "user",
    content: [omittedPayload(text)],
  };
}

function omittedEntry(context: SanitizeContext, text: string): JsonRecord | string {
  return context === "input-item" ? omittedInputItem(text) : omittedPayload(text);
}

function sanitizeValue(
  value: unknown,
  stack = new WeakSet<object>(),
  context: SanitizeContext = "value",
): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) {
    return null;
  }
  if (
    value === undefined ||
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    if (context === "input-item" || context === "content-entry") {
      return omittedEntry(context, NON_JSON_OMITTED_TEXT);
    }
    return omittedText(NON_JSON_OMITTED_TEXT);
  }
  if (Array.isArray(value)) {
    if (stack.has(value)) {
      return omittedEntry(context, CIRCULAR_OMITTED_TEXT);
    }
    stack.add(value);
    try {
      const next: unknown[] = [];
      const entryContext = context === "input-array" ? "input-item" : "content-entry";
      for (let index = 0; index < value.length; index += 1) {
        try {
          next.push(sanitizeValue(value[index], stack, entryContext));
        } catch {
          next.push(omittedEntry(entryContext, UNREADABLE_OMITTED_TEXT));
        }
      }
      return next;
    } finally {
      stack.delete(value);
    }
  }
  if (!isRecord(value)) {
    return value;
  }

  if (stack.has(value)) {
    return omittedEntry(context, CIRCULAR_OMITTED_TEXT);
  }

  stack.add(value);
  try {
    const type = value.type;
    const rawImageUrl = value.image_url;
    if (type === "input_image" && typeof rawImageUrl === "string") {
      const imageUrl = sanitizeSharedInlineImageDataUrl(rawImageUrl);
      if (!imageUrl) {
        return invalidSnakeImage();
      }

      const next: JsonRecord = {};
      for (const [key, child] of Object.entries(value)) {
        if (shouldOmitObjectField(child)) {
          continue;
        }
        next[key] = key === "image_url" ? imageUrl : sanitizeValue(child, stack);
      }
      return next;
    }

    const next: JsonRecord = {};
    for (const [key, child] of Object.entries(value)) {
      if (shouldOmitObjectField(child)) {
        continue;
      }
      next[key] = sanitizeValue(child, stack);
    }
    return next;
  } catch {
    return omittedEntry(context, UNREADABLE_OMITTED_TEXT);
  } finally {
    stack.delete(value);
  }
}

export function sanitizeResponsesImagePayload<T extends Record<string, unknown>>(params: T): T {
  if (!Array.isArray(params.input)) {
    return params;
  }
  return {
    ...params,
    input: sanitizeValue(params.input, new WeakSet(), "input-array"),
  };
}

export function sanitizeInlineImageDataUrl(imageUrl: string): string | undefined {
  return sanitizeSharedInlineImageDataUrl(imageUrl);
}

export function invalidInlineImageText(label: string): string {
  return `[${label}] ${IMAGE_OMITTED_TEXT}`;
}
