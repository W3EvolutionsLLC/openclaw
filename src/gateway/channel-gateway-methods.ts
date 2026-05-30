import { normalizeOptionalString } from "../shared/string-coerce.js";

function readRecordField(
  value: unknown,
  field: string,
): { ok: true; value: unknown } | { ok: false } {
  try {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) {
      return { ok: false };
    }
    return { ok: true, value: (value as Record<string, unknown>)[field] };
  } catch {
    return { ok: false };
  }
}

function pushMethodName(methods: string[], value: unknown) {
  const method = normalizeOptionalString(value);
  if (method) {
    methods.push(method);
  }
}

function readArrayLength(value: unknown): number | undefined {
  try {
    return Array.isArray(value) ? value.length : undefined;
  } catch {
    return undefined;
  }
}

function readArrayElement(
  value: unknown,
  index: number,
): { ok: true; value: unknown } | { ok: false } {
  return readRecordField(value, String(index));
}

export function listChannelPluginGatewayMethodNames(plugin: unknown): string[] {
  const methods: string[] = [];
  const gatewayMethods = readRecordField(plugin, "gatewayMethods");
  if (gatewayMethods.ok) {
    const gatewayMethodValues = gatewayMethods.value;
    const gatewayMethodCount = readArrayLength(gatewayMethodValues);
    if (gatewayMethodCount !== undefined) {
      for (let index = 0; index < gatewayMethodCount; index += 1) {
        const method = readArrayElement(gatewayMethodValues, index);
        if (method.ok) {
          pushMethodName(methods, method.value);
        }
      }
    }
  }
  const descriptors = readRecordField(plugin, "gatewayMethodDescriptors");
  if (descriptors.ok) {
    const descriptorValues = descriptors.value;
    const descriptorCount = readArrayLength(descriptorValues);
    if (descriptorCount !== undefined) {
      for (let index = 0; index < descriptorCount; index += 1) {
        const descriptor = readArrayElement(descriptorValues, index);
        if (descriptor.ok) {
          const name = readRecordField(descriptor.value, "name");
          if (name.ok) {
            pushMethodName(methods, name.value);
          }
        }
      }
    }
  }
  return methods;
}

export function channelPluginSupportsGatewayMethod(plugin: unknown, method: string): boolean {
  return listChannelPluginGatewayMethodNames(plugin).includes(method);
}
