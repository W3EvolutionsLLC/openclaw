import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validatePluginsSessionActionParams,
  validatePluginsSessionActionResult,
  validatePluginsUiDescriptorsParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  isPluginJsonValue,
  type PluginSessionActionRegistration,
} from "../../plugins/host-hooks.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import {
  validateJsonSchemaValue,
  type JsonSchemaValidationError,
  type JsonSchemaValue,
} from "../../plugins/schema-validator.js";
import { isRecord } from "../../shared/record-coerce.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import {
  ADMIN_SCOPE,
  READ_SCOPE,
  WRITE_SCOPE,
  isOperatorScope,
  type OperatorScope,
} from "../operator-scopes.js";
import type { GatewayRequestHandlers } from "./types.js";

const log = createSubsystemLogger("gateway/plugin-host-hooks");
const controlUiSurfaces = new Set(["session", "tool", "run", "settings"]);

function formatSessionActionPayloadSchemaErrors(errors: JsonSchemaValidationError[]): string {
  return errors.map((error) => error.text).join("; ");
}

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

function readNonEmptyStringField(value: unknown, field: string): string | undefined {
  const read = readRecordField(value, field);
  if (!read.ok || typeof read.value !== "string") {
    return undefined;
  }
  const trimmed = read.value.trim();
  return trimmed ? trimmed : undefined;
}

function readControlUiDescriptorSchema(value: unknown): JsonSchemaValue | undefined {
  const read = readRecordField(value, "schema");
  if (!read.ok || read.value === undefined || !isPluginJsonValue(read.value)) {
    return undefined;
  }
  return read.value as JsonSchemaValue;
}

function readControlUiDescriptorRequiredScopes(value: unknown): string[] | undefined {
  const read = readRecordField(value, "requiredScopes");
  if (!read.ok || read.value === undefined) {
    return undefined;
  }
  if (!Array.isArray(read.value)) {
    return undefined;
  }
  const scopes: string[] = [];
  for (const scope of read.value) {
    if (typeof scope !== "string") {
      return undefined;
    }
    const trimmed = scope.trim();
    if (!trimmed) {
      return undefined;
    }
    scopes.push(trimmed);
  }
  return scopes;
}

function projectControlUiDescriptor(entry: unknown): Record<string, unknown> | undefined {
  const pluginId = readNonEmptyStringField(entry, "pluginId");
  if (!pluginId) {
    return undefined;
  }
  const descriptor = readRecordField(entry, "descriptor");
  if (!descriptor.ok) {
    return undefined;
  }
  const id = readNonEmptyStringField(descriptor.value, "id");
  const label = readNonEmptyStringField(descriptor.value, "label");
  const surface = readNonEmptyStringField(descriptor.value, "surface");
  if (!id || !label || !surface || !controlUiSurfaces.has(surface)) {
    return undefined;
  }
  const pluginName = readNonEmptyStringField(entry, "pluginName");
  const description = readNonEmptyStringField(descriptor.value, "description");
  const placement = readNonEmptyStringField(descriptor.value, "placement");
  const schema = readControlUiDescriptorSchema(descriptor.value);
  const requiredScopes = readControlUiDescriptorRequiredScopes(descriptor.value);
  return {
    id,
    pluginId,
    ...(pluginName ? { pluginName } : {}),
    surface,
    label,
    ...(description ? { description } : {}),
    ...(placement ? { placement } : {}),
    ...(schema !== undefined ? { schema } : {}),
    ...(requiredScopes ? { requiredScopes } : {}),
  };
}

function readOperatorScopesField(
  value: unknown,
  field: string,
): OperatorScope[] | undefined | null {
  const read = readRecordField(value, field);
  if (!read.ok) {
    return null;
  }
  if (read.value === undefined) {
    return undefined;
  }
  if (!Array.isArray(read.value)) {
    return null;
  }
  const scopes: OperatorScope[] = [];
  for (const scope of read.value) {
    if (typeof scope !== "string") {
      return null;
    }
    const trimmed = scope.trim();
    if (!isOperatorScope(trimmed)) {
      return null;
    }
    scopes.push(trimmed);
  }
  return scopes.length > 0 ? scopes : undefined;
}

function readSessionActionSchema(action: unknown): JsonSchemaValue | undefined | null {
  const read = readRecordField(action, "schema");
  if (!read.ok) {
    return null;
  }
  if (read.value === undefined) {
    return undefined;
  }
  if (
    !isPluginJsonValue(read.value) ||
    (typeof read.value !== "boolean" && !isRecord(read.value))
  ) {
    return null;
  }
  return read.value as JsonSchemaValue;
}

function readSessionActionHandler(
  action: unknown,
): PluginSessionActionRegistration["handler"] | undefined {
  const read = readRecordField(action, "handler");
  if (!read.ok || typeof read.value !== "function") {
    return undefined;
  }
  return read.value as PluginSessionActionRegistration["handler"];
}

function isPluginLoaded(registry: unknown, pluginId: string): boolean {
  const plugins = readRecordField(registry, "plugins");
  if (!plugins.ok || !Array.isArray(plugins.value)) {
    return false;
  }
  return plugins.value.some((plugin) => {
    return (
      readNonEmptyStringField(plugin, "id") === pluginId &&
      readNonEmptyStringField(plugin, "status") === "loaded"
    );
  });
}

type SessionActionRegistrationLookup =
  | { status: "missing" }
  | { status: "malformed" }
  | {
      status: "found";
      handler: PluginSessionActionRegistration["handler"];
      requiredScopes: OperatorScope[] | undefined;
      schema: JsonSchemaValue | undefined;
    };

function resolveSessionActionRegistration(
  registry: unknown,
  pluginId: string,
  actionId: string,
): SessionActionRegistrationLookup {
  const sessionActions = readRecordField(registry, "sessionActions");
  if (!sessionActions.ok || !Array.isArray(sessionActions.value)) {
    return { status: "missing" };
  }
  let sawMalformedPluginAction = false;
  for (const entry of sessionActions.value) {
    if (readNonEmptyStringField(entry, "pluginId") !== pluginId) {
      continue;
    }
    const action = readRecordField(entry, "action");
    if (!action.ok) {
      sawMalformedPluginAction = true;
      continue;
    }
    const registeredActionId = readNonEmptyStringField(action.value, "id");
    if (!registeredActionId) {
      sawMalformedPluginAction = true;
      continue;
    }
    if (registeredActionId !== actionId) {
      continue;
    }
    const requiredScopes = readOperatorScopesField(action.value, "requiredScopes");
    const schema = readSessionActionSchema(action.value);
    const handler = readSessionActionHandler(action.value);
    if (requiredScopes === null || schema === null || !handler) {
      return { status: "malformed" };
    }
    return { status: "found", handler, requiredScopes, schema };
  }
  return sawMalformedPluginAction ? { status: "malformed" } : { status: "missing" };
}

function validatePluginSessionActionJsonFields(
  result: Record<string, unknown>,
): string | undefined {
  for (const field of ["result", "reply", "details"] as const) {
    if (result[field] !== undefined && !isPluginJsonValue(result[field])) {
      return `plugin session action ${field} must be JSON-compatible`;
    }
  }
  return undefined;
}

export const pluginHostHookHandlers: GatewayRequestHandlers = {
  "plugins.uiDescriptors": ({ params, respond }) => {
    if (!validatePluginsUiDescriptorsParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid plugins.uiDescriptors params: ${formatValidationErrors(validatePluginsUiDescriptorsParams.errors)}`,
        ),
      );
      return;
    }
    const descriptors = (getActivePluginRegistry()?.controlUiDescriptors ?? []).flatMap((entry) => {
      const descriptor = projectControlUiDescriptor(entry);
      return descriptor ? [descriptor] : [];
    });
    respond(true, { ok: true, descriptors }, undefined);
  },
  "plugins.sessionAction": async ({ params, client, respond }) => {
    if (!validatePluginsSessionActionParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid plugins.sessionAction params: ${formatValidationErrors(validatePluginsSessionActionParams.errors)}`,
        ),
      );
      return;
    }
    const pluginId = normalizeOptionalString(params.pluginId);
    const actionId = normalizeOptionalString(params.actionId);
    const sessionKey = normalizeOptionalString(params.sessionKey);
    if (!pluginId || !actionId) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "plugins.sessionAction pluginId and actionId must be non-empty",
        ),
      );
      return;
    }
    const registry = getActivePluginRegistry();
    const pluginLoaded = isPluginLoaded(registry, pluginId);
    const registration = resolveSessionActionRegistration(registry, pluginId, actionId);
    if (registration.status !== "found" || !pluginLoaded) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `unknown plugin session action: ${pluginId}/${actionId}`,
        ),
      );
      return;
    }
    const scopes = Array.isArray(client?.connect.scopes) ? client.connect.scopes : [];
    const hasAdmin = scopes.includes(ADMIN_SCOPE);
    const requiredScopes = registration.requiredScopes ?? [WRITE_SCOPE];
    const missingScope = requiredScopes.find(
      (scope) =>
        !hasAdmin &&
        !scopes.includes(scope) &&
        !(scope === READ_SCOPE && scopes.includes(WRITE_SCOPE)),
    );
    if (missingScope) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `missing scope: ${missingScope}`),
      );
      return;
    }
    try {
      if (params.payload !== undefined && !isPluginJsonValue(params.payload)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "plugin session action payload must be JSON-compatible",
          ),
        );
        return;
      }
      if (registration.schema !== undefined) {
        const validation = validateJsonSchemaValue({
          schema: registration.schema,
          cacheKey: `plugin-session-action:${pluginId}:${actionId}`,
          value: params.payload,
        });
        if (!validation.ok) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `plugin session action payload does not match schema: ${formatSessionActionPayloadSchemaErrors(validation.errors)}`,
            ),
          );
          return;
        }
      }
      const result = await registration.handler({
        pluginId,
        actionId,
        ...(sessionKey ? { sessionKey } : {}),
        ...(params.payload !== undefined ? { payload: params.payload } : {}),
        client: {
          ...(client?.connId ? { connId: client.connId } : {}),
          scopes: [...scopes],
        },
      });
      if (result !== undefined && !isRecord(result)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "plugin session action result must be an object"),
        );
        return;
      }
      const wireResult = result?.ok === false ? result : { ok: true as const, ...result };
      if (!validatePluginsSessionActionResult(wireResult)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid plugin session action result: ${formatValidationErrors(validatePluginsSessionActionResult.errors)}`,
          ),
        );
        return;
      }
      const jsonFieldError = result ? validatePluginSessionActionJsonFields(result) : undefined;
      if (jsonFieldError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, jsonFieldError));
        return;
      }
      if (!wireResult.ok) {
        // Plugin-declared action failures are returned as a successful RPC
        // with `ok: false` per PluginsSessionActionResultSchema. Reserve
        // transport errorShape for protocol-level failures (validation,
        // schema mismatch, dispatch error). Distinguishing these in the
        // wire shape lets callers handle plugin failures (often retryable
        // or user-facing) differently from transport errors (operator
        // diagnostics).
        respond(
          true,
          {
            ok: false,
            error: wireResult.error,
            ...(wireResult.code !== undefined ? { code: wireResult.code } : {}),
            ...(wireResult.details !== undefined ? { details: wireResult.details } : {}),
          },
          undefined,
        );
        return;
      }
      respond(true, {
        ok: true,
        ...(wireResult.result !== undefined ? { result: wireResult.result } : {}),
        ...(wireResult.continueAgent !== undefined
          ? { continueAgent: wireResult.continueAgent }
          : {}),
        ...(wireResult.reply !== undefined ? { reply: wireResult.reply } : {}),
      });
    } catch (error) {
      log.warn(
        `plugin session action failed plugin=${pluginId} action=${actionId}: ${formatErrorMessage(error)}`,
      );
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "plugin session action failed"));
    }
  },
};
