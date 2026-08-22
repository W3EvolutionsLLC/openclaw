import { html, nothing } from "lit";
import type {
  SessionsOperation,
  SessionsOperationStatus,
  SessionsOperationSummary,
} from "../../../../packages/gateway-protocol/src/index.js";
import { icons } from "../../components/icons.ts";
import { renderSettingsPage, renderSettingsSection } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerSessionsManagementEnglish } from "../../i18n/locales/en-sessions-management.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";

registerSessionsManagementEnglish();

type SessionsOperationsProps = {
  operations: SessionsOperationSummary[];
  details: Record<string, SessionsOperation>;
  loading: boolean;
  error: string | null;
  busyId: string | null;
  retryDisabledReason?: string;
  onRefresh: () => void;
  onToggleDetails: (id: string) => void;
  onRetry: (id: string) => void;
};

const STATUS_LABELS = {
  running: "sessionsView.operationRunning",
  completed: "sessionsView.operationCompleted",
  needs_attention: "sessionsView.operationNeedsAttention",
  interrupted: "sessionsView.operationInterrupted",
} as const satisfies Record<SessionsOperationStatus, string>;

function operationStatusLabel(status: SessionsOperationStatus): string {
  return t(STATUS_LABELS[status]);
}

function renderOperationDetails(operation: SessionsOperation) {
  return html`<div
    class="sessions-operation-detail"
    role="region"
    aria-label=${t("sessionsView.operationResults")}
  >
    ${operation.targets.map(
      (target) => html`<div class="sessions-operation-target">
        <div>
          <strong>${target.key}</strong>
          ${target.agentId ? html`<span class="muted">${target.agentId}</span>` : nothing}
        </div>
        <span
          class=${`sessions-operation-target__status sessions-operation-target__status--${target.status}`}
        >
          ${t(`sessionsView.operationTarget_${target.status}`)}
        </span>
        <span class="muted">${target.error?.message ?? target.runId ?? ""}</span>
      </div>`,
    )}
  </div>`;
}

function renderOperationRow(operation: SessionsOperationSummary, props: SessionsOperationsProps) {
  const detail = props.details[operation.id];
  const retryable = operation.counts.failed + operation.counts.pending;
  return html`
    <div class="sessions-operation-row">
      <button
        class="sessions-operation-row__title"
        type="button"
        @click=${() => props.onToggleDetails(operation.id)}
      >
        <strong>${operation.messagePreview}</strong>
        <span class="muted"
          >${t("sessionsView.operationAudience", { count: String(operation.targetCount) })}</span
        >
      </button>
      <span class=${`sessions-operation-status sessions-operation-status--${operation.status}`}>
        ${operationStatusLabel(operation.status)}
      </span>
      <span class="sessions-operation-result">
        ${t("sessionsView.operationCounts", {
          accepted: String(operation.counts.accepted),
          failed: String(operation.counts.failed),
          pending: String(operation.counts.pending),
        })}
      </span>
      <span class="muted"
        >${formatRelativeTimestamp(operation.startedAt ?? operation.createdAt)}</span
      >
      <span class="sessions-operation-row__actions">
        ${retryable > 0
          ? html`<button
              class="btn btn--sm danger"
              ?disabled=${props.busyId === operation.id || Boolean(props.retryDisabledReason)}
              title=${props.retryDisabledReason ?? nothing}
              @click=${() => props.onRetry(operation.id)}
            >
              ${t("sessionsView.retryFailed", { count: String(retryable) })}
            </button>`
          : nothing}
        <button
          class="btn btn--sm"
          ?disabled=${props.busyId === operation.id}
          @click=${() => props.onToggleDetails(operation.id)}
        >
          ${detail ? t("sessionsView.operationHide") : t("sessionsView.operationView")}
        </button>
      </span>
    </div>
    ${detail ? renderOperationDetails(detail) : nothing}
  `;
}

export function renderSessionsOperations(props: SessionsOperationsProps) {
  const running = props.operations.filter((operation) => operation.status === "running").length;
  const attention = props.operations.filter(
    (operation) => operation.status === "needs_attention" || operation.status === "interrupted",
  ).length;
  const children = [
    html`<div class="sessions-facts">
      <span class="sessions-fact"
        ><strong>${props.operations.length}</strong> ${t("sessionsView.operations")}</span
      >
      <span class="sessions-fact__separator">·</span>
      <span class="sessions-fact"
        ><strong>${running}</strong> ${t("sessionsView.operationRunning")}</span
      >
      <span class="sessions-fact__separator">·</span>
      <span class=${`sessions-fact ${attention > 0 ? "danger" : ""}`}
        ><strong>${attention}</strong> ${t("sessionsView.needsAttention")}</span
      >
      <span class="sessions-fact__separator">·</span>
      <span class="sessions-fact">${t("sessionsView.operationRetention")}</span>
    </div>`,
    props.error ? html`<div class="sessions-error" role="alert">${props.error}</div>` : nothing,
    renderSettingsSection(
      {},
      html`<div class="sessions-operations-toolbar">
          <span>${t("sessionsView.operationsDescription")}</span>
          <button class="btn btn--sm" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${icons.refresh} ${props.loading ? t("common.loading") : t("common.refresh")}
          </button>
        </div>
        <div class="sessions-operations-list">
          ${props.loading && props.operations.length === 0
            ? html`<div class="sessions-operation-empty">${t("common.loading")}</div>`
            : props.operations.length === 0
              ? html`<div class="sessions-operation-empty">
                  ${t("sessionsView.operationsEmpty")}
                </div>`
              : props.operations.map((operation) => renderOperationRow(operation, props))}
        </div>`,
    ),
  ];
  return renderSettingsPage(children, { wide: true });
}
