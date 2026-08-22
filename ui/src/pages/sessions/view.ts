import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
// Control UI view renders sessions screen content.
import { html, nothing } from "lit";
import type { SessionsSearchHit } from "../../../../packages/gateway-protocol/src/index.js";
import "../../styles/sessions.css";
import type {
  AgentIdentityResult,
  GatewaySessionRow,
  SessionRunStatus,
  GatewayThinkingLevelOption,
  FastMode,
  SessionCompactionCheckpoint,
  SessionsListResult,
} from "../../api/types.ts";
import { icons } from "../../components/icons.ts";
import "../../components/tooltip.ts";
import "../../components/web-awesome-popover.ts";
import {
  renderSettingsPage,
  renderSettingsSegmented,
  renderSettingsSection,
  renderSettingsStatus,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerSessionsManagementEnglish } from "../../i18n/locales/en-sessions-management.ts";
import { resolveAgentRuntimeLabel } from "../../lib/agents/display.ts";
import {
  formatInheritedThinkingLabel,
  formatThinkingOverrideLabel,
  normalizeThinkingOptionValue,
} from "../../lib/chat/thinking.ts";
import {
  formatDurationCompact,
  formatMs,
  formatRelativeTimestamp,
  formatCompactTokenCount,
} from "../../lib/format.ts";
import { handleContextMenuEvent } from "../../lib/keyboard-shortcuts.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { formatSessionTokens } from "../../lib/presenter.ts";
import { isCronSessionKey } from "../../lib/session-display.ts";
import { formatGoalDetail, formatGoalSummary } from "../../lib/session-goal.ts";
import { sessionModelMatchesDefaults } from "../../lib/session-model-defaults.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import { SESSION_DRAG_MIME } from "../../lib/sessions/drag.ts";
import {
  groupSessionRows,
  normalizeSessionsGroupBy,
  SESSION_GROUP_MODES,
  type SessionRowGroup,
  type SessionsGroupBy,
  UNGROUPED_ID,
} from "../../lib/sessions/grouping.ts";
import {
  DEFAULT_SESSION_LIST_QUERY,
  type SessionArchivedFilter,
} from "../../lib/sessions/index.ts";
import {
  resolveSessionPreferredFace,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import { parseSessionKeyParts } from "../../lib/sessions/session-key.ts";

registerSessionsManagementEnglish();

export type TranscriptSearchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "results";
      results: SessionsSearchHit[];
      indexing: boolean;
      truncated: boolean;
    };

export type SessionsSearchMode = "sessions" | "transcripts";

export type BulkMessageReview = {
  recipients: number;
  busy: number;
  excluded: number;
  message: string;
  submitting: boolean;
  error?: string;
};

export type SessionsProps = {
  loading: boolean;
  result: SessionsListResult | null;
  error: string | null;
  activeMinutes: string;
  limit: string;
  includeGlobal: boolean;
  includeUnknown: boolean;
  statusFilter: SessionArchivedFilter;
  basePath: string;
  agentId: string;
  mainKey: string;
  searchMode: SessionsSearchMode;
  searchQuery: string;
  transcriptSearchAvailable: boolean;
  transcriptSearchQuery: string;
  transcriptSearch: TranscriptSearchState;
  agentIdentityById: Record<string, AgentIdentityResult>;
  sortColumn: "key" | "kind" | "updated" | "tokens";
  sortDir: "asc" | "desc";
  groupBy: SessionsGroupBy;
  /** Multi-identity gateways only; hides the Person mode elsewhere. */
  personGroupingAvailable: boolean;
  knownCategories: string[];
  page: number;
  pageSize: number;
  selectedKeys: Set<string>;
  matchingCount: number;
  selectAllMatchingLoading: boolean;
  bulkMessageAvailable: boolean;
  bulkMessageReview: BulkMessageReview | null;
  sessionMenu: { key: string } | null;
  expandedSessionKey: string | null;
  checkpointItemsByKey: Record<string, SessionCompactionCheckpoint[]>;
  checkpointLoadingKey: string | null;
  checkpointBusyKey: string | null;
  checkpointErrorByKey: Record<string, string>;
  patchWriteDisabledReason?: string;
  patchAdminDisabledReason?: string;
  groupWriteDisabledReason?: string;
  deleteArchivedDisabledReason?: string;
  checkpointBranchDisabledReason?: string;
  checkpointRestoreDisabledReason?: string;
  deleteSelectedDisabledReason?: string;
  onFiltersChange: (next: {
    activeMinutes: string;
    limit: string;
    includeGlobal: boolean;
    includeUnknown: boolean;
  }) => void;
  onClearFilters: () => void;
  onSearchModeChange: (mode: SessionsSearchMode) => void;
  onSearchChange: (query: string) => void;
  onTranscriptSearchChange: (query: string) => void;
  onTranscriptSearch: () => void;
  onClearTranscriptSearch: () => void;
  onSortChange: (column: "key" | "kind" | "updated" | "tokens", dir: "asc" | "desc") => void;
  onGroupByChange: (mode: SessionsGroupBy) => void;
  onAssignCategory: (key: string, category: string | null) => void;
  onRequestNewCategory: (sessionKey?: string) => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  onRefresh: () => void;
  onStatusFilterChange: (statusFilter: SessionArchivedFilter) => void;
  onDeleteAllArchived: () => void;
  onPatch: (
    key: string,
    patch: {
      label?: string | null;
      icon?: string | null;
      category?: string | null;
      archived?: boolean;
      pinned?: boolean;
      unread?: boolean;
      thinkingLevel?: string | null;
      fastMode?: FastMode | null;
      verboseLevel?: string | null;
      reasoningLevel?: string | null;
    },
  ) => void;
  onToggleSelect: (key: string) => void;
  onSelectPage: (keys: string[]) => void;
  onDeselectPage: (keys: string[]) => void;
  onDeselectAll: () => void;
  onSelectAllMatching: () => void;
  onOpenBulkMessage: () => void;
  onBulkMessageChange: (message: string) => void;
  onSubmitBulkMessage: () => void;
  onCancelBulkMessage: () => void;
  onDeleteSelected: () => void;
  onNewSession: () => void;
  onNavigateToChat?: (sessionKey: string) => void;
  onOpenSessionMenu: (
    row: GatewaySessionRow,
    position: { x: number; y: number },
    trigger: HTMLElement | null,
  ) => void;
  onToggleDetails: (sessionKey: string) => void;
  onBranchFromCheckpoint: (sessionKey: string, checkpointId: string) => void | Promise<void>;
  onRestoreCheckpoint: (sessionKey: string, checkpointId: string) => void | Promise<void>;
};

const DEFAULT_THINK_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;
const VERBOSE_LEVEL_VALUES = ["", "off", "on", "full"] as const;
const FAST_LEVEL_VALUES = ["", "auto", "on", "off"] as const;
const REASONING_LEVELS = ["", "off", "on", "stream"] as const;
const PAGE_SIZES = [10, 25, 50, 100] as const;

function getAgentIdentity(
  agentIdentityById: Record<string, AgentIdentityResult>,
  agentId: string,
): AgentIdentityResult | null {
  return Object.hasOwn(agentIdentityById, agentId) ? (agentIdentityById[agentId] ?? null) : null;
}

function resolveThinkLevelOptions(
  row: GatewaySessionRow,
  defaults?: SessionsListResult["defaults"],
): readonly { value: string; label: string }[] {
  const modelMatchesDefaults = sessionModelMatchesDefaults(row, defaults);
  const defaultLabel = formatInheritedThinkingLabel(
    row.thinkingDefault ?? (modelMatchesDefaults ? defaults?.thinkingDefault : undefined),
  );
  const options: readonly GatewayThinkingLevelOption[] = row.thinkingLevels?.length
    ? row.thinkingLevels
    : modelMatchesDefaults && defaults?.thinkingLevels?.length
      ? defaults.thinkingLevels
      : (row.thinkingOptions?.length
          ? row.thinkingOptions
          : modelMatchesDefaults && defaults?.thinkingOptions?.length
            ? defaults.thinkingOptions
            : DEFAULT_THINK_LEVELS
        ).map((label) => ({
          id: normalizeThinkingOptionValue(label),
          label,
        }));
  return [
    { value: "", label: defaultLabel },
    ...options.map((option) => ({
      value: normalizeThinkingOptionValue(option.id),
      label: formatThinkingOverrideLabel(option.id, option.label),
    })),
  ];
}

function withCurrentLabeledOption(
  options: readonly { value: string; label: string }[],
  current: string,
): Array<{ value: string; label: string }> {
  return !current || options.some((option) => option.value === current)
    ? [...options]
    : [...options, { value: current, label: formatThinkingOverrideLabel(current) }];
}

function buildSessionLevelOptions(
  values: readonly string[],
  explicitOff = false,
): Array<{ value: string; label: string }> {
  return values.map((value) => ({
    value,
    label:
      value === ""
        ? t("sessionsView.inherit")
        : explicitOff && value === "off"
          ? t("sessionsView.offExplicit")
          : t(`sessionsView.${value}`),
  }));
}

const SESSION_RUN_STATUS_LABELS = {
  queued: "sessionsView.statusQueued",
  running: "sessionsView.statusRunning",
  done: "sessionsView.statusDone",
  failed: "sessionsView.statusFailed",
  killed: "sessionsView.statusKilled",
  timeout: "sessionsView.statusTimeout",
} as const satisfies Record<SessionRunStatus, string>;

function formatSessionRunStatus(status: SessionRunStatus): string {
  return t(SESSION_RUN_STATUS_LABELS[status] ?? "sessionsView.statusUnknown");
}

function renderSessionStatusBadge(row: GatewaySessionRow) {
  const active = isSessionRunActive(row);
  const idle = row.hasActiveRun === false && (!row.status || row.status === "running");
  const label =
    row.status === "queued"
      ? t("sessionsView.statusQueued")
      : active
        ? t("sessionsView.statusLive")
        : idle
          ? t("sessionsView.statusIdle")
          : row.status
            ? formatSessionRunStatus(row.status)
            : t("sessionsView.statusUnknown");
  const kind =
    row.status === "queued"
      ? "warn"
      : active || row.status === "done"
        ? "ok"
        : idle || !row.status
          ? "muted"
          : "danger";
  const title = `${t("sessionsView.status")}: ${label}`;
  return html`
    <openclaw-tooltip .content=${title}>
      ${renderSettingsStatus({ kind, label })}
    </openclaw-tooltip>
  `;
}

const SESSION_KIND_ICONS = {
  cron: icons.clock,
  direct: icons.messageSquare,
  group: icons.users,
  global: icons.globe,
  unknown: icons.circle,
} satisfies Record<GatewaySessionRow["kind"] | "cron", unknown>;

// The server row kind never carries "cron" — cron is a key-shape fact, so the
// display kind derives it from the key for the avatar, badge class, and label.
function resolveSessionDisplayKind(row: GatewaySessionRow): GatewaySessionRow["kind"] | "cron" {
  return isCronSessionKey(row.key) ? "cron" : row.kind;
}

// Kind glyph anchors each row; the dot mirrors isSessionRunActive so run
// state also reads at the identity anchor while scanning the key column.
function renderSessionAvatar(row: GatewaySessionRow) {
  const displayKind = resolveSessionDisplayKind(row);
  return html`
    <span class="session-avatar session-avatar--${displayKind}" aria-hidden="true">
      ${SESSION_KIND_ICONS[displayKind] ?? icons.circle}
      ${isSessionRunActive(row) ? html`<span class="session-avatar__status"></span>` : nothing}
    </span>
  `;
}

const CONTEXT_METER_WARN_PERCENT = 65;
const CONTEXT_METER_DANGER_PERCENT = 85;

function hasKnownTokenTotal(row: GatewaySessionRow): boolean {
  return typeof row.totalTokens === "number" && Number.isFinite(row.totalTokens);
}

function renderTokensCell(row: GatewaySessionRow) {
  const total = row.totalTokens;
  if (typeof total !== "number" || !Number.isFinite(total)) {
    return html`<span class="muted">${t("common.na")}</span>`;
  }
  // Stale snapshots (post-compaction, incomplete usage reporting) stay visible
  // as "~" orientation but must not drive warn/danger tones; mirrors the chat
  // composer's context-usage convention.
  const fresh = row.totalTokensFresh !== false;
  const totalLabel = `${fresh ? "" : "~"}${formatCompactTokenCount(total)}`;
  const context =
    typeof row.contextTokens === "number" && row.contextTokens > 0 ? row.contextTokens : null;
  if (!context) {
    return html`<span class="session-tokens__value">${totalLabel}</span>`;
  }
  const percent = Math.min(100, Math.round((total / context) * 100));
  const tone = !fresh
    ? "stale"
    : percent >= CONTEXT_METER_DANGER_PERCENT
      ? "danger"
      : percent >= CONTEXT_METER_WARN_PERCENT
        ? "warn"
        : "ok";
  const title = t(fresh ? "sessionsView.contextUsage" : "sessionsView.contextUsageApprox", {
    percent: String(percent),
    used: total.toLocaleString(),
    context: context.toLocaleString(),
  });
  return html`
    <openclaw-tooltip .content=${title}>
      <div class="session-tokens">
        <span class="session-tokens__value"
          >${totalLabel} / ${formatCompactTokenCount(context)}</span
        >
        <span
          class="session-context-meter session-context-meter--${tone}"
          role="img"
          aria-label=${title}
        >
          <span class="session-context-meter__fill" style=${`width: ${percent}%`}></span>
        </span>
      </div>
    </openclaw-tooltip>
  `;
}

function renderSessionsFacts(
  rows: GatewaySessionRow[],
  liveCount: number,
  statusFilter: SessionArchivedFilter,
) {
  const unreadCount = rows.filter((row) => row.unread === true && row.archived !== true).length;
  const archivedCount = rows.filter((row) => row.archived === true).length;
  // Sum only known token totals; "~" marks the sum as partial/approximate when
  // rows lack a snapshot or carry a stale one, and no snapshot at all is n/a
  // rather than a fabricated 0.
  const rowsWithTokens = rows.filter(hasKnownTokenTotal);
  const totalTokens = rowsWithTokens.reduce((sum, row) => sum + (row.totalTokens ?? 0), 0);
  const tokensApproximate =
    rowsWithTokens.length < rows.length ||
    rowsWithTokens.some((row) => row.totalTokensFresh === false);
  const tokensValue =
    rowsWithTokens.length === 0
      ? t("common.na")
      : `${tokensApproximate ? "~" : ""}${formatCompactTokenCount(totalTokens)}`;
  const attentionCount = rows.filter(
    (row) => row.status === "failed" || row.status === "timeout" || row.status === "killed",
  ).length;
  const fact = (value: string, label: string, tone = "") => html`
    <span class=${`sessions-fact ${tone}`.trim()}><strong>${value}</strong> ${label}</span>
  `;
  return html`
    <div class="sessions-facts" aria-label=${t("sessionsView.overview")}>
      ${fact(String(rows.length), t("sessionsView.title"))}
      <span class="sessions-fact__separator" aria-hidden="true">·</span>
      ${fact(String(liveCount), t("sessionsView.statusLive"))}
      <span class="sessions-fact__separator" aria-hidden="true">·</span>
      ${fact(String(unreadCount), t("sessionsView.unread"))}
      ${attentionCount > 0
        ? html`<span class="sessions-fact__separator" aria-hidden="true">·</span> ${fact(
              String(attentionCount),
              t("sessionsView.needsAttention"),
              "danger",
            )}`
        : nothing}
      <span class="sessions-fact__separator" aria-hidden="true">·</span>
      ${fact(tokensValue, t("sessionsView.tokens"))}
      ${statusFilter !== "active"
        ? html`<span class="sessions-fact__separator" aria-hidden="true">·</span> ${fact(
              String(archivedCount),
              t("sessionsView.archived"),
            )}`
        : nothing}
    </div>
  `;
}

function transcriptSearchSessionLabel(hit: SessionsSearchHit, rows: GatewaySessionRow[]): string {
  const row = rows.find((candidate) => candidate.key === hit.sessionKey);
  return (
    normalizeOptionalString(row?.label) ??
    normalizeOptionalString(row?.displayName) ??
    hit.sessionKey
  );
}

function renderTranscriptSearchResults(props: SessionsProps, rows: GatewaySessionRow[]) {
  const state = props.transcriptSearch;
  const results = state.status === "results" ? state.results : [];
  const loading = state.status === "loading";
  return html`
    <section
      class="sessions-transcript-search"
      aria-label=${t("sessionsView.transcriptSearchTitle")}
    >
      ${!props.transcriptSearchAvailable
        ? html`
            <div class="sessions-inline-notice" role="status">
              ${t("sessionsView.transcriptSearchUnavailable")}
            </div>
          `
        : nothing}
      <div
        class="sessions-transcript-search__status"
        aria-live="polite"
        aria-busy=${loading ? "true" : "false"}
      >
        ${loading
          ? html`<span class="muted">${t("sessionsView.transcriptSearchSearching")}</span>`
          : nothing}
        ${state.status === "error"
          ? html`
              <div
                class="sessions-transcript-search__notice sessions-transcript-search__notice--danger"
              >
                <span>${t("sessionsView.transcriptSearchError")}: ${state.message}</span>
                <button class="btn btn--sm" type="button" @click=${props.onTranscriptSearch}>
                  ${t("sessionsView.transcriptSearchRetry")}
                </button>
              </div>
            `
          : nothing}
        ${state.status === "results" && state.indexing
          ? html`
              <div class="sessions-transcript-search__notice">
                <span>${t("sessionsView.transcriptSearchIndexing")}</span>
                <button
                  class="btn btn--sm"
                  type="button"
                  ?disabled=${loading}
                  @click=${props.onTranscriptSearch}
                >
                  ${t("sessionsView.transcriptSearchRetry")}
                </button>
              </div>
            `
          : nothing}
        ${state.status === "results" && results.length === 0 && !state.indexing
          ? html`
              <div class="sessions-transcript-search__empty" role="status">
                ${t("sessionsView.transcriptSearchEmpty")}
              </div>
            `
          : nothing}
        ${results.length > 0
          ? html`
              <div class="sessions-transcript-search__results">
                <div class="sessions-transcript-search__summary">
                  <strong
                    >${t("sessionsView.transcriptSearchMatches", {
                      count: String(results.length),
                    })}</strong
                  >
                  ${state.status === "results" && state.truncated
                    ? html`<span class="muted"
                        >${t("sessionsView.transcriptSearchTruncated")}</span
                      >`
                    : nothing}
                </div>
                <div class="sessions-transcript-search__list">
                  ${results.map((hit) => {
                    const timestamp =
                      hit.timestamp > 0 ? formatRelativeTimestamp(hit.timestamp) : t("common.na");
                    const timestampTitle = hit.timestamp > 0 ? formatMs(hit.timestamp) : timestamp;
                    return html`
                      <button
                        class="sessions-transcript-search__result"
                        type="button"
                        @click=${() => props.onNavigateToChat?.(hit.sessionKey)}
                      >
                        <span class="sessions-transcript-search__result-header">
                          <strong>${transcriptSearchSessionLabel(hit, rows)}</strong>
                          <span class="muted" title=${timestampTitle}>
                            ${t(`sessionsView.${hit.role}`)} · ${timestamp}
                          </span>
                        </span>
                        <span class="sessions-transcript-search__snippet">${hit.snippet}</span>
                        <span class="sessions-transcript-search__key">${hit.sessionKey}</span>
                      </button>
                    `;
                  })}
                </div>
              </div>
            `
          : nothing}
      </div>
    </section>
  `;
}

const SKELETON_ROW_COUNT = 4;

// Initial load renders shimmer rows instead of flashing the empty state
// before the first sessions.list result arrives.
function renderSkeletonRows(columnCount: number) {
  return Array.from(
    { length: SKELETON_ROW_COUNT },
    (_, rowIndex) => html`
      <tr class="session-skeleton-row" aria-hidden="true">
        ${Array.from({ length: columnCount }, (_cell, columnIndex) =>
          columnIndex === 0
            ? html`<td class="data-table-checkbox-col"></td>`
            : html`<td>
                <span
                  class="session-skeleton ${columnIndex === 1 ? "session-skeleton--key" : ""}"
                  style=${`animation-delay: ${rowIndex * 120}ms`}
                ></span>
              </td>`,
        )}
      </tr>
    `,
  );
}

export function filterSessionRowsForQuery(
  rows: GatewaySessionRow[],
  query: string,
  agentIdentityById: Record<string, AgentIdentityResult>,
): GatewaySessionRow[] {
  const q = normalizeLowercaseStringOrEmpty(query);
  if (!q) {
    return rows;
  }
  return rows.filter((row) => {
    const fields = [
      row.key,
      row.label,
      row.category,
      row.kind,
      row.displayName,
      resolveAgentRuntimeLabel(row.agentRuntime),
      row.status,
      row.goal
        ? `${row.goal.objective} ${row.goal.status} ${formatGoalSummary(row.goal)} ${
            row.goal.lastStatusNote ?? ""
          }`
        : "",
      isSessionRunActive(row) ? "live running" : row.hasActiveRun === false ? "idle" : "",
    ];
    if (fields.some((value) => normalizeLowercaseStringOrEmpty(value).includes(q))) {
      return true;
    }
    const keyParts = parseSessionKeyParts(row.key);
    const identityName = keyParts
      ? normalizeLowercaseStringOrEmpty(getAgentIdentity(agentIdentityById, keyParts.agentId)?.name)
      : "";
    return identityName.includes(q);
  });
}

function sortRows(
  rows: GatewaySessionRow[],
  column: "key" | "kind" | "updated" | "tokens",
  dir: "asc" | "desc",
): GatewaySessionRow[] {
  const cmp = dir === "asc" ? 1 : -1;
  return [...rows].toSorted((a, b) => {
    const pinnedDiff = (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0);
    if (pinnedDiff !== 0) {
      return pinnedDiff;
    }
    const diff =
      column === "key" || column === "kind"
        ? (a[column] ?? "").localeCompare(b[column] ?? "")
        : column === "updated"
          ? (a.updatedAt ?? 0) - (b.updatedAt ?? 0)
          : (a.totalTokens ?? a.inputTokens ?? a.outputTokens ?? 0) -
            (b.totalTokens ?? b.inputTokens ?? b.outputTokens ?? 0);
    return diff * cmp;
  });
}

function paginateRows<T>(rows: T[], page: number, pageSize: number): T[] {
  const start = page * pageSize;
  return rows.slice(start, start + pageSize);
}

function hasActiveFilters(props: SessionsProps): boolean {
  return (
    normalizeLowercaseStringOrEmpty(props.searchQuery).length > 0 ||
    parseStrictPositiveInteger(props.activeMinutes) !== undefined ||
    !props.includeGlobal
  );
}

const CHECKPOINT_REASON_LABELS = {
  manual: "sessionsView.manual",
  "auto-threshold": "sessionsView.autoThreshold",
  "overflow-retry": "sessionsView.overflowRetry",
  "timeout-retry": "sessionsView.timeoutRetry",
} as const satisfies Record<SessionCompactionCheckpoint["reason"], string>;

function formatCheckpointReason(reason: SessionCompactionCheckpoint["reason"]): string {
  const label = CHECKPOINT_REASON_LABELS[reason];
  return label ? t(label) : reason;
}

function formatCheckpointCount(count: number): string {
  return count === 1
    ? t("sessionsView.checkpoint", { count: String(count) })
    : t("sessionsView.checkpoints", { count: String(count) });
}

function formatCheckpointDelta(checkpoint: SessionCompactionCheckpoint): string {
  if (
    typeof checkpoint.tokensBefore === "number" &&
    typeof checkpoint.tokensAfter === "number" &&
    Number.isFinite(checkpoint.tokensBefore) &&
    Number.isFinite(checkpoint.tokensAfter)
  ) {
    return t("sessionsView.tokenRange", {
      before: checkpoint.tokensBefore.toLocaleString(),
      after: checkpoint.tokensAfter.toLocaleString(),
    });
  }
  if (typeof checkpoint.tokensBefore === "number" && Number.isFinite(checkpoint.tokensBefore)) {
    return t("sessionsView.tokensBefore", { count: checkpoint.tokensBefore.toLocaleString() });
  }
  return t("sessionsView.tokenDeltaUnavailable");
}

function formatRuntimeMs(runtimeMs: number | undefined): string | null {
  if (typeof runtimeMs !== "number" || !Number.isFinite(runtimeMs) || runtimeMs < 0) {
    return null;
  }
  return formatDurationCompact(runtimeMs) ?? "0ms";
}

// Goal state is a dot + summary; the tooltip carries the objective detail.
function renderSessionGoalStatus(goal: GatewaySessionRow["goal"]) {
  if (!goal) {
    return nothing;
  }
  const kind =
    goal.status === "active"
      ? "accent"
      : goal.status === "complete"
        ? "ok"
        : goal.status === "blocked" ||
            goal.status === "budget_limited" ||
            goal.status === "usage_limited"
          ? "warn"
          : "muted";
  const detail = formatGoalDetail(goal);
  // tabindex lets keyboard users trigger the tooltip; aria-label exposes the
  // full objective detail that sighted users only get on hover.
  return html`
    <openclaw-tooltip .content=${detail}>
      <span tabindex="0" aria-label=${detail}>
        ${renderSettingsStatus({ kind, label: formatGoalSummary(goal) })}
      </span>
    </openclaw-tooltip>
  `;
}

function sessionDetailItems(params: {
  row: GatewaySessionRow;
  updated: string;
  checkpointCount: number;
}): Array<{ label: string; value: string }> {
  const { row, updated, checkpointCount } = params;
  const details: Array<{ label: string; value: string }> = [
    { label: t("sessionsView.key"), value: row.key },
    { label: t("sessionsView.kind"), value: row.kind },
    { label: t("sessionsView.updated"), value: updated },
    { label: t("sessionsView.tokens"), value: formatSessionTokens(row) },
    { label: t("sessionsView.compaction"), value: formatCheckpointCount(checkpointCount) },
  ];
  const add = (label: string, value: string | null | undefined) => {
    const normalized = normalizeOptionalString(value);
    if (normalized) {
      details.push({ label, value: normalized });
    }
  };
  add(t("sessionsView.group"), row.category);
  add(t("sessionsView.status"), row.status);
  if (row.goal) {
    details.push({ label: t("sessionsView.goal"), value: formatGoalDetail(row.goal) });
  }
  add(t("sessionsView.goalNote"), row.goal?.lastStatusNote);
  add(t("sessionsView.model"), row.model);
  add(t("sessionsView.provider"), row.modelProvider);
  // The roster dropped its Runtime column; the drawer is where agent runtime
  // and run duration live now.
  add(t("sessionsView.runtime"), resolveAgentRuntimeLabel(row.agentRuntime));
  add(t("sessionsView.runDuration"), formatRuntimeMs(row.runtimeMs));
  add(t("sessionsView.surface"), row.surface);
  add(t("sessionsView.subject"), row.subject);
  add(t("sessionsView.room"), row.room);
  add(t("sessionsView.space"), row.space);
  add(t("sessionsView.sessionId"), row.sessionId);
  for (const [label, value] of [
    [t("sessionsView.activeRun"), row.hasActiveRun],
    [t("sessionsView.archived"), row.archived],
    [t("sessionsView.pinned"), row.pinned],
  ] as const) {
    if (typeof value === "boolean") {
      details.push({ label, value: value ? t("common.yes") : t("common.no") });
    }
  }
  return details;
}

const NEW_GROUP_OPTION = "__new-group__";

function sessionsTableColumnCount(props: SessionsProps): number {
  return props.groupBy === "category" ? 8 : 7;
}

const SESSION_GROUP_MODE_LABELS = {
  none: "sessionsView.groupByNone",
  category: "sessionsView.groupByCategory",
  person: "sessionsView.groupByPerson",
  channel: "sessionsView.groupByChannel",
  kind: "sessionsView.groupByKind",
  agent: "sessionsView.groupByAgent",
  date: "sessionsView.groupByDate",
} as const satisfies Record<SessionsGroupBy, string>;

function groupModeLabel(mode: SessionsGroupBy): string {
  return t(SESSION_GROUP_MODE_LABELS[mode] ?? SESSION_GROUP_MODE_LABELS.none);
}

function sessionGroupLabel(group: SessionRowGroup, props: SessionsProps): string {
  const { id } = group;
  if (props.groupBy === "date") {
    const labels: Record<string, string> = {
      today: "sessionsView.dateToday",
      yesterday: "sessionsView.dateYesterday",
      week: "sessionsView.dateThisWeek",
      older: "sessionsView.dateOlder",
    };
    return t(labels[id] ?? "sessionsView.dateNoActivity");
  }
  if (id === UNGROUPED_ID) {
    return t("sessionsView.ungrouped");
  }
  if (props.groupBy === "agent") {
    const identity = getAgentIdentity(props.agentIdentityById, id);
    const name = normalizeOptionalString(identity?.name);
    if (name) {
      const emoji = normalizeOptionalString(identity?.emoji);
      return emoji ? `${emoji} ${name}` : name;
    }
  }
  if (props.groupBy === "person") {
    return group.rows[0]?.owner?.actor.label?.trim() || id;
  }
  return id;
}

// Drag-over highlighting toggles a class directly on the target row instead of
// re-rendering per dragover event; lit re-renders mid-drag would cancel the drag.
function setDropTargetActive(event: DragEvent, active: boolean) {
  (event.currentTarget as HTMLElement | null)?.classList.toggle(
    "session-drop-target--active",
    active,
  );
}

function categoryDropHandlers(props: SessionsProps, category: string | null) {
  if (props.groupBy !== "category" || props.groupWriteDisabledReason) {
    return { dragover: nothing, dragleave: nothing, drop: nothing } as const;
  }
  const carriesSessionKey = (event: DragEvent) =>
    event.dataTransfer?.types.includes(SESSION_DRAG_MIME) === true;
  return {
    dragover: (event: DragEvent) => {
      if (!carriesSessionKey(event)) {
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "move";
      }
      setDropTargetActive(event, true);
    },
    dragleave: (event: DragEvent) => setDropTargetActive(event, false),
    drop: (event: DragEvent) => {
      if (!carriesSessionKey(event)) {
        return;
      }
      event.preventDefault();
      setDropTargetActive(event, false);
      const key = event.dataTransfer?.getData(SESSION_DRAG_MIME);
      if (key) {
        props.onAssignCategory(key, category);
      }
    },
  } as const;
}

function renderGroupHeaderRow(group: SessionRowGroup, props: SessionsProps) {
  const label = sessionGroupLabel(group, props);
  const count =
    group.rows.length === 1
      ? t("sessionsView.groupRowCountOne", { count: "1" })
      : t("sessionsView.groupRowCount", { count: String(group.rows.length) });
  const drop = categoryDropHandlers(props, group.id === UNGROUPED_ID ? null : group.id);
  return html`
    <tr
      class="session-group-row"
      @dragover=${drop.dragover}
      @dragleave=${drop.dragleave}
      @drop=${drop.drop}
    >
      <td colspan=${sessionsTableColumnCount(props)}>
        <div class="session-group-row__header">
          <span class="session-group-row__icon" aria-hidden="true">${icons.folder}</span>
          <span class="session-group-row__label">${label}</span>
          <span class="session-group-row__count">${count}</span>
        </div>
      </td>
    </tr>
  `;
}

function renderCategoryCell(row: GatewaySessionRow, props: SessionsProps) {
  const current = normalizeOptionalString(row.category) ?? "";
  const options = [...props.knownCategories];
  if (current && !options.includes(current)) {
    options.push(current);
  }
  return html`
    <td>
      <select
        ?disabled=${props.loading || Boolean(props.groupWriteDisabledReason)}
        title=${props.groupWriteDisabledReason ?? nothing}
        aria-label=${t("sessionsView.moveToGroup")}
        class="session-group-select"
        @change=${(e: Event) => {
          if (props.groupWriteDisabledReason) {
            return;
          }
          const select = e.target as HTMLSelectElement;
          if (select.value === NEW_GROUP_OPTION) {
            // The page prompts for a name and patches; restore until the refresh lands.
            select.value = current;
            props.onRequestNewCategory(row.key);
            return;
          }
          props.onAssignCategory(row.key, select.value || null);
        }}
      >
        <option value="" ?selected=${!current}>${t("sessionsView.ungrouped")}</option>
        ${options.map(
          (name) => html`<option value=${name} ?selected=${current === name}>${name}</option>`,
        )}
        <option value=${NEW_GROUP_OPTION}>${t("sessionsView.newGroup")}</option>
      </select>
    </td>
  `;
}

function isRowControlTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(target.closest("a, button, input, label, select, textarea"))
  );
}

function formControlValue(event: Event): string {
  const target = event.currentTarget;
  return target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement
    ? target.value
    : "";
}

function normalizeSearchMode(value: string): SessionsSearchMode {
  return value === "transcripts" ? "transcripts" : "sessions";
}

function parseSessionSort(value: string): {
  column: SessionsProps["sortColumn"];
  direction: SessionsProps["sortDir"];
} {
  switch (value) {
    case "updated:asc":
      return { column: "updated", direction: "asc" };
    case "key:asc":
      return { column: "key", direction: "asc" };
    case "tokens:desc":
      return { column: "tokens", direction: "desc" };
    default:
      return { column: "updated", direction: "desc" };
  }
}

function renderFilterToggle(params: {
  name: string;
  checked: boolean;
  label: string;
  title: string;
  extraClass?: string;
  onChange: (checked: boolean) => void;
}) {
  const className = [
    "session-filter-check",
    "session-filter-toggle",
    params.extraClass ?? "",
    params.checked ? "session-filter-check--active" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return html`
    <openclaw-tooltip .content=${params.title}>
      <label class=${className}>
        <input
          name=${params.name}
          class="session-filter-check__input"
          type="checkbox"
          .checked=${params.checked}
          @change=${(e: Event) => params.onChange((e.target as HTMLInputElement).checked)}
        />
        <span class="session-filter-check__mark" aria-hidden="true">${icons.check}</span>
        <span class="session-filter-check__label">${params.label}</span>
      </label>
    </openclaw-tooltip>
  `;
}

function renderOverrideSelect(params: {
  label: string;
  disabled: boolean;
  disabledReason?: string;
  options: readonly { value: string; label: string }[];
  current: string;
  onChange: (value: string) => void;
}) {
  return html`
    <label class="session-override-field">
      <span class="session-override-field__label">${params.label}</span>
      <select
        class="settings-select"
        ?disabled=${params.disabled}
        title=${params.disabledReason ?? nothing}
        @change=${(e: Event) => params.onChange((e.target as HTMLSelectElement).value)}
      >
        ${params.options.map(
          (option) =>
            html`<option value=${option.value} ?selected=${params.current === option.value}>
              ${option.label}
            </option>`,
        )}
      </select>
    </label>
  `;
}

function renderBulkMessageReview(review: BulkMessageReview, props: SessionsProps) {
  return html`
    <section class="sessions-bulk-review" aria-label=${t("sessionsView.messageReview")}>
      <div class="sessions-bulk-review__composer">
        <label class="field">
          <span>${t("sessionsView.message")}</span>
          <textarea
            class="settings-textarea"
            rows="4"
            maxlength="20000"
            .value=${review.message}
            placeholder=${t("sessionsView.messagePlaceholder")}
            ?disabled=${review.submitting}
            @input=${(event: Event) => props.onBulkMessageChange(formControlValue(event))}
          ></textarea>
        </label>
      </div>
      <dl class="sessions-bulk-review__summary">
        <div>
          <dt>${t("sessionsView.audience")}</dt>
          <dd>${review.recipients}</dd>
        </div>
        <div>
          <dt>${t("sessionsView.busySessions")}</dt>
          <dd>${review.busy}</dd>
        </div>
        <div>
          <dt>${t("sessionsView.excluded")}</dt>
          <dd>${review.excluded}</dd>
        </div>
        <div>
          <dt>${t("sessionsView.delivery")}</dt>
          <dd>${t("sessionsView.queuePolicy")}</dd>
        </div>
      </dl>
      ${review.error
        ? html`<div class="sessions-inline-notice sessions-inline-notice--danger" role="alert">
            ${review.error}
          </div>`
        : nothing}
      <div class="sessions-bulk-review__actions">
        <button
          class="btn btn--sm"
          ?disabled=${review.submitting}
          @click=${props.onCancelBulkMessage}
        >
          ${t("common.cancel")}
        </button>
        <button
          class="btn btn--sm primary"
          ?disabled=${review.submitting || review.recipients === 0 || !review.message.trim()}
          @click=${props.onSubmitBulkMessage}
        >
          ${review.submitting
            ? t("sessionsView.startingOperation")
            : t("sessionsView.startOperation")}
        </button>
      </div>
    </section>
  `;
}

export function renderSessions(props: SessionsProps) {
  const rawRows = props.result?.sessions ?? [];
  const filtered = filterSessionRowsForQuery(rawRows, props.searchQuery, props.agentIdentityById);
  const sorted = sortRows(filtered, props.sortColumn, props.sortDir);
  const totalRows = sorted.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / props.pageSize));
  const page = Math.min(props.page, totalPages - 1);
  const groups =
    props.groupBy !== "none"
      ? groupSessionRows({
          rows: sorted,
          mode: props.groupBy,
          knownCategories: props.knownCategories,
        })
      : null;
  const displayRows = groups ? groups.flatMap((group) => group.rows) : sorted;
  const paginated = paginateRows(displayRows, page, props.pageSize);
  const emptyBecauseFiltered =
    rawRows.length === 0 ? hasActiveFilters(props) : filtered.length === 0;
  const liveCount = rawRows.filter((row) => isSessionRunActive(row)).length;
  const emptyMessage =
    props.statusFilter === "archived"
      ? t("sessionsView.noArchivedSessions")
      : props.statusFilter === "active"
        ? t("sessionsView.noActiveSessions")
        : t("sessionsView.noSessions");

  const sortHeader = (
    col: "key" | "kind" | "updated" | "tokens",
    label: string,
    extraClass = "",
  ) => {
    const isActive = props.sortColumn === col;
    const nextDir = isActive && props.sortDir === "asc" ? ("desc" as const) : ("asc" as const);
    return html`
      <th
        class=${extraClass}
        data-sortable
        data-sort-dir=${isActive ? props.sortDir : ""}
        aria-sort=${isActive ? (props.sortDir === "asc" ? "ascending" : "descending") : nothing}
        @click=${() => props.onSortChange(col, isActive ? nextDir : "desc")}
      >
        <button class="data-table-sort-button" type="button">
          ${label}
          <span class="data-table-sort-icon" aria-hidden="true">${icons.arrowUpDown}</span>
        </button>
      </th>
    `;
  };

  const children = [
    props.error ? html`<div class="sessions-error" role="alert">${props.error}</div>` : nothing,
    props.result ? renderSessionsFacts(rawRows, liveCount, props.statusFilter) : nothing,
    renderSettingsSection(
      {},
      renderSessionsTable(props, {
        paginated,
        groups,
        emptyBecauseFiltered,
        emptyMessage,
        totalRows,
        totalPages,
        page,
        sortHeader,
      }),
    ),
  ];
  return renderSettingsPage(children, { wide: true });
}

type SessionsTableContext = {
  paginated: GatewaySessionRow[];
  groups: SessionRowGroup[] | null;
  emptyBecauseFiltered: boolean;
  emptyMessage: string;
  totalRows: number;
  totalPages: number;
  page: number;
  sortHeader: (
    col: "key" | "kind" | "updated" | "tokens",
    label: string,
    extraClass?: string,
  ) => unknown;
};

function renderSessionsTable(props: SessionsProps, ctx: SessionsTableContext) {
  const { paginated, groups, emptyBecauseFiltered, emptyMessage, totalRows, totalPages, page } =
    ctx;
  const sortHeader = ctx.sortHeader;
  const emptyStateMessage = emptyBecauseFiltered
    ? t("sessionsView.noSessionsMatchFilters")
    : emptyMessage;
  // Archived timestamps are intentionally stale, so recency only applies to the active view.
  const filterInputs = [
    [
      "activeMinutes",
      "minutes",
      t("sessionsView.active"),
      t("sessionsView.activeTooltip", { count: props.activeMinutes.trim() }),
      t("sessionsView.minutesPlaceholder"),
      props.statusFilter !== "active",
    ],
    ["limit", "limit", t("sessionsView.limit"), t("sessionsView.limitTooltip"), nothing, false],
  ] as const;
  const sourceFilters = [
    ["includeGlobal", t("sessionsView.global"), t("sessionsView.globalTooltip")],
    ["includeUnknown", t("sessionsView.unknown"), t("sessionsView.unknownTooltip")],
  ] as const;
  const { activeMinutes, limit, includeGlobal, includeUnknown } = props;
  const updateFilter = (
    key: keyof Parameters<SessionsProps["onFiltersChange"]>[0],
    value: string | boolean,
  ) => props.onFiltersChange({ activeMinutes, limit, includeGlobal, includeUnknown, [key]: value });
  const paginatedKeys = groups ? new Set(paginated.map((row) => row.key)) : null;
  const transcriptMode = props.searchMode === "transcripts";
  const searchValue = transcriptMode ? props.transcriptSearchQuery : props.searchQuery;
  const filterCount = [
    Boolean(props.activeMinutes.trim()),
    props.limit !== String(DEFAULT_SESSION_LIST_QUERY.limit),
    !props.includeGlobal,
    props.includeUnknown,
    props.groupBy !== "none",
    props.sortColumn !== "updated" || props.sortDir !== "desc",
  ].filter(Boolean).length;
  return html`
    ${props.selectedKeys.size > 0
      ? html`
          <div class="data-table-bulk-bar">
            <strong
              >${t("sessionsView.selected", { count: String(props.selectedKeys.size) })}</strong
            >
            ${props.selectedKeys.size < props.matchingCount
              ? html`<button
                  class="btn btn--sm btn--ghost"
                  ?disabled=${props.selectAllMatchingLoading}
                  @click=${props.onSelectAllMatching}
                >
                  ${props.selectAllMatchingLoading
                    ? t("sessionsView.selectingAllMatching")
                    : t("sessionsView.selectAllMatching", {
                        count: String(props.matchingCount),
                      })}
                </button>`
              : nothing}
            ${props.bulkMessageAvailable
              ? html`<button class="btn btn--sm primary" @click=${props.onOpenBulkMessage}>
                  ${icons.messageSquare} ${t("sessionsView.sendMessage")}
                </button>`
              : nothing}
            <button
              class="btn btn--sm danger"
              ?disabled=${props.loading || Boolean(props.deleteSelectedDisabledReason)}
              title=${props.deleteSelectedDisabledReason ?? nothing}
              @click=${props.onDeleteSelected}
            >
              ${icons.trash} ${t("sessionsView.deleteSelected")}
            </button>
            <button class="btn btn--sm" @click=${props.onDeselectAll}>
              ${t("common.unselect")}
            </button>
          </div>
        `
      : html`
          <div
            class="sessions-toolbar sessions-filter-bar"
            aria-label=${t("sessionsView.filterControls")}
          >
            <form
              class="sessions-search-control"
              role="search"
              @submit=${(event: SubmitEvent) => {
                event.preventDefault();
                if (transcriptMode && props.transcriptSearchAvailable && searchValue.trim()) {
                  props.onTranscriptSearch();
                }
              }}
            >
              <select
                class="sessions-search-control__mode"
                aria-label=${t("sessionsView.searchMode")}
                .value=${props.searchMode}
                @change=${(event: Event) =>
                  props.onSearchModeChange(normalizeSearchMode(formControlValue(event)))}
              >
                <option value="sessions">${t("sessionsView.searchSessions")}</option>
                <option value="transcripts">${t("sessionsView.searchTranscripts")}</option>
              </select>
              <div class="data-table-search sessions-toolbar__search">
                ${icons.search}
                <input
                  type="search"
                  maxlength=${transcriptMode ? "4096" : nothing}
                  placeholder=${transcriptMode
                    ? t("sessionsView.transcriptSearchPlaceholder")
                    : t("sessionsView.searchPlaceholder")}
                  .value=${searchValue}
                  ?disabled=${transcriptMode && !props.transcriptSearchAvailable}
                  @input=${(event: Event) => {
                    const value = formControlValue(event);
                    if (transcriptMode) {
                      props.onTranscriptSearchChange(value);
                    } else {
                      props.onSearchChange(value);
                    }
                  }}
                />
              </div>
              ${transcriptMode
                ? html`<button
                    class="btn btn--sm primary"
                    type="submit"
                    ?disabled=${!props.transcriptSearchAvailable ||
                    !searchValue.trim() ||
                    props.transcriptSearch.status === "loading"}
                  >
                    ${props.transcriptSearch.status === "loading"
                      ? t("sessionsView.transcriptSearchSearching")
                      : t("sessionsView.transcriptSearchAction")}
                  </button>`
                : nothing}
            </form>
            ${renderSettingsSegmented<SessionArchivedFilter>({
              value: props.statusFilter,
              ariaLabel: t("sessionsView.sessionState"),
              className: "sessions-view-segment",
              options: [
                { value: "active", label: t("common.active") },
                { value: "archived", label: t("sessionsView.archived") },
                { value: "all", label: t("sessionsView.all") },
              ],
              onChange: (value) => props.onStatusFilterChange(value),
            })}
            <button
              id="sessions-filter-trigger"
              class=${`btn btn--sm sessions-filter-trigger ${filterCount > 0 ? "active" : ""}`}
              type="button"
              aria-haspopup="dialog"
              aria-label=${t("sessionsView.filters")}
              title=${t("sessionsView.filters")}
            >
              ${icons.listFilter}${filterCount > 0
                ? html`<span class="settings-count">${filterCount}</span>`
                : nothing}
            </button>
            <wa-popover
              class="sessions-filter-popover"
              for="sessions-filter-trigger"
              placement="bottom-end"
              without-arrow
            >
              <div class="sessions-filter-popover__panel">
                <div class="sessions-filter-popover__grid">
                  ${filterInputs.map(
                    ([key, suffix, label, tooltip, placeholder, disabled]) => html`
                      <label class="field" title=${tooltip}>
                        <span>${label}</span>
                        <input
                          class="settings-input session-filter-input--${suffix}"
                          placeholder=${placeholder}
                          .value=${props[key]}
                          ?disabled=${disabled}
                          @input=${(event: Event) => updateFilter(key, formControlValue(event))}
                        />
                      </label>
                    `,
                  )}
                  <label class="field">
                    <span>${t("sessionsView.groupBy")}</span>
                    <select
                      class="settings-select sessions-groupby-select"
                      @change=${(event: Event) =>
                        props.onGroupByChange(normalizeSessionsGroupBy(formControlValue(event)))}
                    >
                      ${SESSION_GROUP_MODES.filter(
                        (mode) => mode !== "person" || props.personGroupingAvailable,
                      ).map(
                        (mode) => html`<option value=${mode} ?selected=${props.groupBy === mode}>
                          ${groupModeLabel(mode)}
                        </option>`,
                      )}
                    </select>
                  </label>
                  <label class="field">
                    <span>${t("sessionsView.sort")}</span>
                    <select
                      class="settings-select"
                      @change=${(event: Event) => {
                        const sort = parseSessionSort(formControlValue(event));
                        props.onSortChange(sort.column, sort.direction);
                      }}
                    >
                      ${[
                        ["updated:desc", t("sessionsView.sortUpdatedNewest")],
                        ["updated:asc", t("sessionsView.sortUpdatedOldest")],
                        ["key:asc", t("sessionsView.sortNameAscending")],
                        ["tokens:desc", t("sessionsView.sortContextHighest")],
                      ].map(
                        ([value, label]) => html`<option
                          value=${value}
                          ?selected=${value === `${props.sortColumn}:${props.sortDir}`}
                        >
                          ${label}
                        </option>`,
                      )}
                    </select>
                  </label>
                </div>
                <div
                  class="sessions-filter-popover__sources"
                  role="group"
                  aria-label=${t("sessionsView.sourceFilters")}
                >
                  ${sourceFilters.map(([key, label, tooltip]) =>
                    renderFilterToggle({
                      name: key,
                      checked: props[key],
                      label,
                      title: tooltip,
                      onChange: (checked) => updateFilter(key, checked),
                    }),
                  )}
                </div>
                <div class="sessions-filter-popover__actions">
                  ${props.groupBy === "category"
                    ? html`<button
                        class="btn btn--sm"
                        ?disabled=${Boolean(props.groupWriteDisabledReason)}
                        title=${props.groupWriteDisabledReason ?? nothing}
                        @click=${() => props.onRequestNewCategory()}
                      >
                        ${icons.plus} ${t("sessionsView.newGroup")}
                      </button>`
                    : nothing}
                  <button
                    class="btn btn--sm"
                    ?disabled=${filterCount === 0}
                    @click=${props.onClearFilters}
                  >
                    ${t("sessionsView.resetFilters")}
                  </button>
                  ${props.statusFilter === "archived"
                    ? html`<button
                        class="btn btn--sm danger"
                        ?disabled=${props.loading || Boolean(props.deleteArchivedDisabledReason)}
                        title=${props.deleteArchivedDisabledReason ?? nothing}
                        @click=${props.onDeleteAllArchived}
                      >
                        ${icons.trash} ${t("sessionsView.deleteAllArchived")}
                      </button>`
                    : nothing}
                </div>
              </div>
            </wa-popover>
            <button
              class="btn btn--sm btn--ghost sessions-refresh"
              ?disabled=${props.loading}
              @click=${props.onRefresh}
              title=${t("common.refresh")}
              aria-label=${t("common.refresh")}
            >
              ${icons.refresh}
            </button>
            <button class="btn btn--sm primary sessions-new" @click=${props.onNewSession}>
              ${icons.plus} ${t("sessionsView.newSession")}
            </button>
          </div>
        `}
    ${props.bulkMessageReview ? renderBulkMessageReview(props.bulkMessageReview, props) : nothing}
    ${transcriptMode
      ? renderTranscriptSearchResults(props, props.result?.sessions ?? [])
      : html`<div class="data-table-container">
            <table class="data-table sessions-table">
              <thead>
                <tr>
                  <th class="data-table-checkbox-col">
                    ${paginated.length > 0
                      ? html`<input
                          type="checkbox"
                          .checked=${paginated.length > 0 &&
                          paginated.every((r) => props.selectedKeys.has(r.key))}
                          .indeterminate=${paginated.some((r) => props.selectedKeys.has(r.key)) &&
                          !paginated.every((r) => props.selectedKeys.has(r.key))}
                          @change=${() => {
                            const allSelected = paginated.every((r) =>
                              props.selectedKeys.has(r.key),
                            );
                            if (allSelected) {
                              props.onDeselectPage(paginated.map((r) => r.key));
                            } else {
                              props.onSelectPage(paginated.map((r) => r.key));
                            }
                          }}
                          aria-label=${t("sessionsView.selectAllOnPage")}
                        />`
                      : nothing}
                  </th>
                  ${sortHeader("key", t("sessionsView.key"), "data-table-key-col")}
                  ${props.groupBy === "category"
                    ? html`<th>${t("sessionsView.group")}</th>`
                    : nothing}
                  ${sortHeader("kind", t("sessionsView.kind"))}
                  <th class="session-status-col">${t("sessionsView.status")}</th>
                  ${sortHeader("updated", t("sessionsView.updated"))}
                  ${sortHeader("tokens", t("sessionsView.tokens"))}
                  <th class="session-actions-col">
                    <span class="sr-only">${t("sessionsView.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                ${props.loading && !props.result
                  ? renderSkeletonRows(sessionsTableColumnCount(props))
                  : paginated.length === 0
                    ? html`
                        <tr>
                          <td
                            colspan=${sessionsTableColumnCount(props)}
                            class="data-table-empty-cell"
                          >
                            <div class="data-table-empty-state" role="status" aria-live="polite">
                              <div class="data-table-empty-state__message">
                                ${emptyBecauseFiltered ? icons.search : icons.messageSquare}
                                <span>${emptyStateMessage}</span>
                              </div>
                              ${emptyBecauseFiltered
                                ? html`
                                    <button class="btn btn--sm" @click=${props.onClearFilters}>
                                      ${t("sessionsView.showAll")}
                                    </button>
                                  `
                                : nothing}
                            </div>
                          </td>
                        </tr>
                      `
                    : groups
                      ? groups.flatMap((group) => {
                          const visibleRows = group.rows.filter((row) =>
                            paginatedKeys?.has(row.key),
                          );
                          if (visibleRows.length === 0 && group.rows.length > 0) {
                            return [];
                          }
                          const section = visibleRows.flatMap((row) => renderRows(row, props));
                          section.unshift(renderGroupHeaderRow(group, props));
                          return section;
                        })
                      : paginated.flatMap((row) => renderRows(row, props))}
              </tbody>
            </table>
          </div>

          ${totalRows > 0
            ? html`
                <div class="data-table-pagination">
                  <div class="data-table-pagination__info">
                    ${t("sessionsView.pagination", {
                      start: String(page * props.pageSize + 1),
                      end: String(Math.min((page + 1) * props.pageSize, totalRows)),
                      total: String(totalRows),
                    })}
                  </div>
                  <div class="data-table-pagination__controls">
                    <select
                      class="data-table-pagination__size"
                      aria-label=${t("sessionsView.pageSize")}
                      .value=${String(props.pageSize)}
                      @change=${(e: Event) =>
                        props.onPageSizeChange(Number((e.target as HTMLSelectElement).value))}
                    >
                      ${PAGE_SIZES.map(
                        // The matching option owns initial selection because the select's value
                        // property binds before these dynamic children exist on first render.
                        (s) =>
                          html`<option value=${s} ?selected=${s === props.pageSize}>
                            ${t("sessionsView.rowsPerPage", { count: String(s) })}
                          </option>`,
                      )}
                    </select>
                    <button ?disabled=${page <= 0} @click=${() => props.onPageChange(page - 1)}>
                      ${t("common.previous")}
                    </button>
                    <button
                      ?disabled=${page >= totalPages - 1}
                      @click=${() => props.onPageChange(page + 1)}
                    >
                      ${t("common.next")}
                    </button>
                  </div>
                </div>
              `
            : nothing}`}
  `;
}

function renderRows(row: GatewaySessionRow, props: SessionsProps) {
  const updated = row.updatedAt ? formatRelativeTimestamp(row.updatedAt) : t("common.na");
  const latestCheckpoint = row.latestCompactionCheckpoint;
  const checkpointCount = row.compactionCheckpointCount ?? 0;
  const visibleCheckpointCount = Math.max(checkpointCount, latestCheckpoint ? 1 : 0);
  const hasCheckpoints = checkpointCount > 0 || Boolean(latestCheckpoint);
  const isExpanded = props.expandedSessionKey === row.key;
  const detailsId = `session-details-${encodeURIComponent(row.key)}`;
  const displayName = normalizeOptionalString(row.displayName) ?? null;
  const trimmedLabel = normalizeOptionalString(row.label) ?? "";
  const showDisplayName = Boolean(
    displayName && displayName !== row.key && displayName !== trimmedLabel,
  );
  const keyParts = parseSessionKeyParts(row.key);
  const agentIdentity = keyParts
    ? getAgentIdentity(props.agentIdentityById, keyParts.agentId)
    : null;
  const identityEmoji = normalizeOptionalString(agentIdentity?.emoji) ?? "";
  const identityName = normalizeOptionalString(agentIdentity?.name) ?? "";
  const friendlyKeyLabel =
    identityName && keyParts
      ? `${identityEmoji ? `${identityEmoji} ` : ""}${identityName} (${keyParts.channel})`
      : null;
  const keyCellTitle = friendlyKeyLabel ?? row.key;
  const canLink = row.kind !== "global";
  const chatUrl = canLink
    ? sessionNavigationTarget({
        face: resolveSessionPreferredFace(row),
        sessionKey: row.key,
        fallbackAgentId: props.agentId,
        basePath: props.basePath,
        row,
        mainKey: props.mainKey,
        preferenceDerivedFace: true,
      }).href
    : null;
  const displayKind = resolveSessionDisplayKind(row);
  const kindClass = `session-kind session-kind--${displayKind}`;
  const rowClass = [
    "session-data-row",
    "session-data-row--expandable",
    props.statusFilter === "all" && row.archived === true ? "session-data-row--archived" : "",
    isExpanded ? "session-data-row--expanded" : "",
    props.sessionMenu?.key === row.key ? "session-data-row--menu-open" : "",
  ]
    .filter(Boolean)
    .join(" ");
  // The {count} placeholder predates the drawer redesign; it carries the session title.
  const detailsToggleLabel = isExpanded
    ? t("sessionsView.hideSessionDetails", { count: keyCellTitle })
    : t("sessionsView.showSessionDetails", { count: keyCellTitle });
  const categoryMode = props.groupBy === "category";
  // Dropping on a row targets that row's group so the whole section area accepts drops.
  const rowDrop = categoryDropHandlers(props, normalizeOptionalString(row.category) ?? null);
  const openMenuFromEvent = (event: MouseEvent | KeyboardEvent) =>
    handleContextMenuEvent(
      event,
      event instanceof KeyboardEvent
        ? (event.currentTarget as HTMLElement).querySelector('button[aria-haspopup="menu"]')
        : null,
      (trigger, x, y) => props.onOpenSessionMenu(row, { x, y }, trigger),
    );

  return [
    html`<tr
      class=${rowClass}
      tabindex="0"
      aria-expanded=${String(isExpanded)}
      aria-controls=${detailsId}
      draggable=${categoryMode ? "true" : nothing}
      aria-description=${categoryMode ? t("sessionsView.dragSessionHint") : nothing}
      @dragstart=${categoryMode
        ? (e: DragEvent) => {
            e.dataTransfer?.setData(SESSION_DRAG_MIME, row.key);
            if (e.dataTransfer) {
              e.dataTransfer.effectAllowed = "move";
            }
          }
        : nothing}
      @dragover=${rowDrop.dragover}
      @dragleave=${rowDrop.dragleave}
      @drop=${rowDrop.drop}
      @contextmenu=${openMenuFromEvent}
      @click=${(e: MouseEvent) => {
        if (isRowControlTarget(e.target)) {
          return;
        }
        props.onToggleDetails(row.key);
      }}
      @keydown=${(e: KeyboardEvent) => {
        openMenuFromEvent(e);
        if (e.defaultPrevented) {
          return;
        }
        if (isRowControlTarget(e.target)) {
          return;
        }
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          props.onToggleDetails(row.key);
        }
      }}
    >
      <td class="data-table-checkbox-col">
        <input
          type="checkbox"
          .checked=${props.selectedKeys.has(row.key)}
          @change=${() => props.onToggleSelect(row.key)}
          aria-label=${`${t("sessionsView.selectSession")}: ${row.key}`}
        />
      </td>
      <td class="data-table-key-col">
        <openclaw-tooltip .content=${keyCellTitle}>
          <div class=${friendlyKeyLabel ? "session-key-cell" : "mono session-key-cell"}>
            ${renderSessionAvatar(row)}
            <div class="session-key-cell__text">
              <span class="session-key-cell__primary">
                ${row.unread === true
                  ? html`<span
                      class="session-unread-dot"
                      role="img"
                      aria-label=${t("sessionsView.unread")}
                    ></span>`
                  : nothing}
                ${canLink
                  ? html`<a
                      href=${chatUrl}
                      class="session-link"
                      @click=${(e: MouseEvent) => {
                        if (!shouldHandleNavigationClick(e)) {
                          return;
                        }
                        if (props.onNavigateToChat) {
                          e.preventDefault();
                          props.onNavigateToChat(row.key);
                        }
                      }}
                      >${friendlyKeyLabel ?? row.key}</a
                    >`
                  : html`<span>${friendlyKeyLabel ?? row.key}</span>`}
                ${trimmedLabel
                  ? html`<span class="session-label-chip" title=${trimmedLabel}
                      >${trimmedLabel}</span
                    >`
                  : nothing}
              </span>
              ${showDisplayName
                ? html`<span class="muted session-key-display-name">${displayName}</span>`
                : nothing}
            </div>
          </div>
        </openclaw-tooltip>
      </td>
      ${categoryMode ? renderCategoryCell(row, props) : nothing}
      <td>
        <span class=${kindClass}>${resolveSessionDisplayKind(row)}</span>
      </td>
      <td class="session-status-col">
        <div class="session-status-stack">
          ${renderSessionStatusBadge(row)} ${renderSessionGoalStatus(row.goal)}
          ${props.statusFilter === "all" && row.archived === true
            ? renderSettingsStatus({ kind: "muted", label: t("sessionsView.archived") })
            : nothing}
        </div>
      </td>
      <td>${updated}</td>
      <td class="session-token-cell">${renderTokensCell(row)}</td>
      <td class="session-actions-cell">
        <div class="session-actions">
          <button
            class="session-details-toggle"
            type="button"
            aria-expanded=${String(isExpanded)}
            aria-controls=${detailsId}
            aria-label=${detailsToggleLabel}
            @click=${(e: MouseEvent) => {
              e.stopPropagation();
              props.onToggleDetails(row.key);
            }}
          >
            ${visibleCheckpointCount > 0
              ? html`<span class="settings-count session-compaction-count"
                  >${visibleCheckpointCount}</span
                >`
              : nothing}
            ${icons.chevronDown}
          </button>
          <button
            class="icon-btn"
            type="button"
            title=${t("chat.sidebar.openSessionMenu")}
            aria-label=${t("chat.sidebar.openSessionMenu")}
            aria-haspopup="menu"
            aria-expanded=${String(props.sessionMenu?.key === row.key)}
            @click=${(event: MouseEvent) => {
              event.stopPropagation();
              const trigger = event.currentTarget as HTMLElement;
              const rect = trigger.getBoundingClientRect();
              props.onOpenSessionMenu(row, { x: rect.right, y: rect.bottom + 4 }, trigger);
            }}
          >
            ${icons.moreHorizontal}
          </button>
        </div>
      </td>
    </tr>`,
    ...(isExpanded
      ? [
          renderSessionDetailsRow({
            row,
            props,
            detailsId,
            friendlyKeyLabel,
            displayName,
            showDisplayName,
            kindClass,
            updated,
            visibleCheckpointCount,
            hasCheckpoints,
          }),
        ]
      : []),
  ];
}

function renderSessionDetailsRow(params: {
  row: GatewaySessionRow;
  props: SessionsProps;
  detailsId: string;
  friendlyKeyLabel: string | null;
  displayName: string | null;
  showDisplayName: boolean;
  kindClass: string;
  updated: string;
  visibleCheckpointCount: number;
  hasCheckpoints: boolean;
}) {
  const {
    row,
    props,
    detailsId,
    friendlyKeyLabel,
    displayName,
    showDisplayName,
    kindClass,
    updated,
    visibleCheckpointCount,
    hasCheckpoints,
  } = params;
  const rawThinking = row.thinkingLevel ?? "";
  const thinking = rawThinking ? normalizeThinkingOptionValue(rawThinking) : "";
  const thinkLevels = withCurrentLabeledOption(
    resolveThinkLevelOptions(row, props.result?.defaults),
    thinking,
  );
  const fastMode =
    row.fastMode === "auto"
      ? "auto"
      : row.fastMode === true
        ? "on"
        : row.fastMode === false
          ? "off"
          : "";
  const fastLevels = withCurrentLabeledOption(
    buildSessionLevelOptions(FAST_LEVEL_VALUES),
    fastMode,
  );
  const verbose = row.verboseLevel ?? "";
  const verboseLevels = withCurrentLabeledOption(
    buildSessionLevelOptions(VERBOSE_LEVEL_VALUES, true),
    verbose,
  );
  const reasoning = row.reasoningLevel ?? "";
  const reasoningLevels = withCurrentLabeledOption(
    buildSessionLevelOptions(REASONING_LEVELS),
    reasoning,
  );
  const checkpointItems = props.checkpointItemsByKey[row.key] ?? [];
  const checkpointError = props.checkpointErrorByKey[row.key];
  const checkpointLabel = formatCheckpointCount(visibleCheckpointCount);
  const sessionDetails = sessionDetailItems({
    row,
    updated,
    checkpointCount: visibleCheckpointCount,
  });

  return html`<tr id=${detailsId} class="session-details-row">
    <td colspan=${sessionsTableColumnCount(props)}>
      <div class="session-details-panel">
        <div class="session-details-panel__hero">
          <div>
            <div class="session-details-panel__eyebrow">${t("sessionsView.sessionDetails")}</div>
            <div class="session-details-panel__title">${friendlyKeyLabel ?? row.key}</div>
            ${showDisplayName
              ? html`<div class="muted session-details-panel__subtitle">${displayName}</div>`
              : nothing}
          </div>
          <div class="session-details-panel__badges">
            ${renderSessionStatusBadge(row)} ${renderSessionGoalStatus(row.goal)}
            <span class=${kindClass}>${resolveSessionDisplayKind(row)}</span>
          </div>
        </div>

        <div class="session-details-section">
          <div class="session-details-panel__eyebrow">${t("sessionsView.overrides")}</div>
          <div class="session-overrides-grid">
            <label class="session-override-field">
              <span class="session-override-field__label">${t("sessionsView.label")}</span>
              <input
                class="settings-input"
                .value=${row.label ?? ""}
                ?disabled=${props.loading || Boolean(props.patchWriteDisabledReason)}
                title=${props.patchWriteDisabledReason ?? nothing}
                placeholder=${t("sessionsView.optionalPlaceholder")}
                @change=${(e: Event) => {
                  const value =
                    normalizeOptionalString((e.target as HTMLInputElement).value) ?? null;
                  props.onPatch(row.key, { label: value });
                }}
              />
            </label>
            ${renderOverrideSelect({
              label: t("sessionsView.thinking"),
              disabled: props.loading || Boolean(props.patchAdminDisabledReason),
              disabledReason: props.patchAdminDisabledReason,
              options: thinkLevels,
              current: thinking,
              onChange: (value) => props.onPatch(row.key, { thinkingLevel: value || null }),
            })}
            ${renderOverrideSelect({
              label: t("sessionsView.fast"),
              disabled: props.loading || Boolean(props.patchAdminDisabledReason),
              disabledReason: props.patchAdminDisabledReason,
              options: fastLevels,
              current: fastMode,
              onChange: (value) =>
                props.onPatch(row.key, {
                  fastMode: value === "" ? null : value === "auto" ? "auto" : value === "on",
                }),
            })}
            ${renderOverrideSelect({
              label: t("sessionsView.verbose"),
              disabled: props.loading || Boolean(props.patchAdminDisabledReason),
              disabledReason: props.patchAdminDisabledReason,
              options: verboseLevels,
              current: verbose,
              onChange: (value) => props.onPatch(row.key, { verboseLevel: value || null }),
            })}
            ${renderOverrideSelect({
              label: t("sessionsView.reasoning"),
              disabled: props.loading || Boolean(props.patchAdminDisabledReason),
              disabledReason: props.patchAdminDisabledReason,
              options: reasoningLevels,
              current: reasoning,
              onChange: (value) => props.onPatch(row.key, { reasoningLevel: value || null }),
            })}
          </div>
        </div>

        <div class="session-details-grid">
          ${sessionDetails.map(
            (item) => html`
              <div class="session-detail-stat">
                <div class="session-detail-stat__label">${item.label}</div>
                <openclaw-tooltip .content=${item.value}>
                  <div class="session-detail-stat__value">${item.value}</div>
                </openclaw-tooltip>
              </div>
            `,
          )}
        </div>

        <div class="session-details-section">
          <div class="session-details-section__header">
            <div>
              <div class="session-details-panel__eyebrow">
                ${t("sessionsView.compactionHistory")}
              </div>
              <div class="session-details-section__title">${checkpointLabel}</div>
            </div>
          </div>
          ${props.checkpointLoadingKey === row.key
            ? html`<div class="muted session-details-empty">
                ${t("sessionsView.loadingCheckpoints")}
              </div>`
            : checkpointError
              ? html`<div class="callout danger" role="alert">${checkpointError}</div>`
              : !hasCheckpoints || checkpointItems.length === 0
                ? html`<div class="muted session-details-empty">
                    ${t("sessionsView.noCheckpoints")}
                  </div>`
                : html`
                    <div class="session-checkpoint-list">
                      ${checkpointItems.map(
                        (checkpoint) => html`
                          <div class="session-checkpoint-card">
                            <div class="session-checkpoint-card__header">
                              <strong>
                                ${formatCheckpointReason(checkpoint.reason)} ·
                                ${formatRelativeTimestamp(checkpoint.createdAt)}
                              </strong>
                              <span class="muted session-checkpoint-card__delta">
                                ${formatCheckpointDelta(checkpoint)}
                              </span>
                            </div>
                            ${checkpoint.summary
                              ? html`<div class="session-checkpoint-card__summary">
                                  ${checkpoint.summary}
                                </div>`
                              : html`<div class="muted">${t("sessionsView.noSummary")}</div>`}
                            <div class="session-checkpoint-card__actions">
                              <button
                                class="btn btn--sm"
                                ?disabled=${props.checkpointBusyKey === checkpoint.checkpointId ||
                                Boolean(props.checkpointBranchDisabledReason)}
                                title=${props.checkpointBranchDisabledReason ?? nothing}
                                @click=${() =>
                                  props.onBranchFromCheckpoint(row.key, checkpoint.checkpointId)}
                              >
                                ${t("sessionsView.branchFromCheckpoint")}
                              </button>
                              <button
                                class="btn btn--sm"
                                ?disabled=${props.checkpointBusyKey === checkpoint.checkpointId ||
                                Boolean(props.checkpointRestoreDisabledReason)}
                                title=${props.checkpointRestoreDisabledReason ?? nothing}
                                @click=${() =>
                                  props.onRestoreCheckpoint(row.key, checkpoint.checkpointId)}
                              >
                                ${t("sessionsView.restoreCheckpoint")}
                              </button>
                            </div>
                          </div>
                        `,
                      )}
                    </div>
                  `}
        </div>
      </div>
    </td>
  </tr>`;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
