// Shared error graph/format helpers without the full infra-runtime surface.

export const SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_CODE = "OPENCLAW_SUBAGENT_RUNTIME_REQUEST_SCOPE";
export const SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_MESSAGE =
  "Plugin runtime subagent methods are only available during a gateway request.";
export const SUBAGENT_EXTRA_SYSTEM_PROMPT_NOT_AUTHORIZED_ERROR_CODE =
  "OPENCLAW_SUBAGENT_EXTRA_SYSTEM_PROMPT_NOT_AUTHORIZED";
export const SUBAGENT_EXTRA_SYSTEM_PROMPT_NOT_AUTHORIZED_ERROR_MESSAGE =
  "extraSystemPrompt is not authorized for this plugin subagent run.";

export class RequestScopedSubagentRuntimeError extends Error {
  code = SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_CODE;

  constructor(message = SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_MESSAGE) {
    super(message);
    this.name = "RequestScopedSubagentRuntimeError";
  }
}

export class SubagentExtraSystemPromptNotAuthorizedError extends Error {
  code = SUBAGENT_EXTRA_SYSTEM_PROMPT_NOT_AUTHORIZED_ERROR_CODE;

  constructor(message = SUBAGENT_EXTRA_SYSTEM_PROMPT_NOT_AUTHORIZED_ERROR_MESSAGE) {
    super(message);
    this.name = "SubagentExtraSystemPromptNotAuthorizedError";
  }
}

export {
  collectErrorGraphCandidates,
  extractErrorCode,
  formatErrorMessage,
  formatUncaughtError,
  readErrorName,
} from "../infra/errors.js";
export { isApprovalNotFoundError } from "../infra/approval-errors.ts";
