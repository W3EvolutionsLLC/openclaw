import { html, nothing } from "lit";
import type { LlmTraceDetail, LlmTraceSummary, TraceCapability } from "../controllers/traces.ts";
import { normalizeLowercaseStringOrEmpty } from "../string-coerce.ts";

export type TracesProps = {
  loading: boolean;
  error: string | null;
  capability: TraceCapability | null;
  entries: LlmTraceSummary[];
  selected: LlmTraceDetail | null;
  selectedId: string | null;
  filterText: string;
  onFilterTextChange: (next: string) => void;
  onRefresh: () => void;
  onSelect: (id: string) => void;
};

function formatTime(value?: string): string {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleTimeString();
}

function formatBytes(value?: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(value?: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "running";
  }
  if (value < 1000) {
    return `${Math.round(value)} ms`;
  }
  return `${(value / 1000).toFixed(2)} s`;
}

function formatCount(value: number | undefined, singular: string, plural = `${singular}s`): string {
  const count = value ?? 0;
  return `${count} ${count === 1 ? singular : plural}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatJson(value: unknown): string {
  if (value === undefined) {
    return "Not captured";
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return typeof value === "bigint" ? value.toString() : "[Unserializable value]";
  }
}

function readableRole(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function roleClassName(role: string): string {
  const token = normalizeLowercaseStringOrEmpty(role).replace(/[^a-z0-9_-]+/g, "-");
  return token ? `role-${token}` : "role-unknown";
}

function stringifyReadable(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value === null || value === undefined) {
    return "";
  }
  return formatJson(value);
}

function contentPartText(part: unknown): string | null {
  if (typeof part === "string") {
    return part;
  }
  if (!isRecord(part)) {
    return null;
  }
  if (typeof part.text === "string") {
    return part.text;
  }
  if (typeof part.content === "string") {
    return part.content;
  }
  if (part.type === "input_text" && typeof part.text === "string") {
    return part.text;
  }
  if (part.type === "output_text" && typeof part.text === "string") {
    return part.text;
  }
  return null;
}

function contentPartLabel(part: unknown): string | null {
  if (!isRecord(part)) {
    return null;
  }
  return typeof part.type === "string" ? part.type : "content";
}

function formatMessageContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const textParts = value.map(contentPartText).filter((text): text is string => Boolean(text));
    if (textParts.length > 0) {
      return textParts.join("\n\n");
    }
    const labels = value.map(contentPartLabel).filter((label): label is string => Boolean(label));
    if (labels.length > 0) {
      return labels.map((label) => `[${label}]`).join(" ");
    }
  }
  return stringifyReadable(value);
}

function formatJsonString(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

type ReadableMessage = {
  role: string;
  name?: string;
  content: string;
  raw: unknown;
};

function normalizeMessage(value: unknown, fallbackRole: string): ReadableMessage | null {
  if (!isRecord(value)) {
    const content = stringifyReadable(value);
    return content ? { content, raw: value, role: fallbackRole } : null;
  }
  if (value.type === "function_call") {
    const name = typeof value.name === "string" && value.name ? value.name : undefined;
    const args = typeof value.arguments === "string" ? formatJsonString(value.arguments) : "{}";
    return {
      content: name ? `${name}(\n${args}\n)` : args,
      raw: value,
      role: "tool call",
      ...(name ? { name } : {}),
    };
  }
  const role = readableRole(
    value.role ?? (value.type === "function_call_output" ? "tool" : value.type),
    fallbackRole,
  );
  const content = formatMessageContent(
    value.content ??
      value.text ??
      value.input ??
      value.message ??
      value.output ??
      value.arguments ??
      value,
  );
  return {
    content,
    raw: value,
    role,
    ...(typeof value.name === "string" && value.name
      ? { name: value.name }
      : typeof value.call_id === "string" && value.call_id
        ? { name: value.call_id }
        : {}),
  };
}

function requestMessages(trace: LlmTraceDetail | null): ReadableMessage[] {
  const payload = trace?.requestPayload;
  if (!isRecord(payload)) {
    return [];
  }
  const normalizedMessages: ReadableMessage[] = [];
  if (typeof payload.instructions === "string" && payload.instructions.trim()) {
    normalizedMessages.push({
      content: payload.instructions,
      raw: { instructions: payload.instructions },
      role: "instructions",
    });
  }
  const messages = payload.messages ?? payload.input;
  if (Array.isArray(messages)) {
    normalizedMessages.push(
      ...messages
        .map((message, index) => normalizeMessage(message, `input ${index + 1}`))
        .filter((message): message is ReadableMessage => Boolean(message)),
    );
    return normalizedMessages;
  }
  const normalized = normalizeMessage(messages, "input");
  if (normalized) {
    normalizedMessages.push(normalized);
  }
  return normalizedMessages;
}

function requestInputs(trace: LlmTraceDetail | null): unknown {
  const payload = trace?.requestPayload;
  if (!isRecord(payload)) {
    return undefined;
  }
  return payload.input ?? payload.messages;
}

function requestTools(trace: LlmTraceDetail | null): unknown {
  const payload = trace?.requestPayload;
  if (!isRecord(payload)) {
    return undefined;
  }
  return payload.tools ?? payload.functions;
}

type ReadableTool = {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  required: Set<string>;
  raw: unknown;
};

function toolRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  const nested = isRecord(value.function) ? value.function : value;
  return nested;
}

function toolName(value: unknown, index: number): string {
  const record = toolRecord(value);
  if (!record) {
    return `Tool ${index + 1}`;
  }
  return typeof record.name === "string" && record.name.trim() ? record.name : `Tool ${index + 1}`;
}

function normalizeTool(value: unknown, index: number): ReadableTool {
  const record = toolRecord(value);
  const parameters = isRecord(record?.parameters) ? record.parameters : undefined;
  const required = Array.isArray(parameters?.required)
    ? parameters.required.filter((item): item is string => typeof item === "string")
    : [];
  return {
    name: toolName(value, index),
    ...(typeof record?.description === "string" && record.description
      ? { description: record.description }
      : {}),
    ...(parameters ? { parameters } : {}),
    raw: value,
    required: new Set(required),
  };
}

function requestReadableTools(trace: LlmTraceDetail | null): ReadableTool[] {
  const tools = requestTools(trace);
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools.map(normalizeTool);
}

function requestParams(trace: LlmTraceDetail | null): unknown {
  const payload = trace?.requestPayload;
  if (!isRecord(payload)) {
    return undefined;
  }
  const {
    input: _input,
    instructions: _instructions,
    messages: _messages,
    tools: _tools,
    functions: _functions,
    ...rest
  } = payload;
  return rest;
}

function visibleResponseDelta(chunk: unknown): string {
  if (!isRecord(chunk) || typeof chunk.type !== "string") {
    return "";
  }
  if (
    chunk.type !== "text_delta" &&
    chunk.type !== "response.output_text.delta" &&
    chunk.type !== "response.refusal.delta" &&
    chunk.type !== "output.text.delta"
  ) {
    return "";
  }
  if (typeof chunk.delta === "string") {
    return chunk.delta;
  }
  return typeof chunk.text === "string" ? chunk.text : "";
}

function finalResponseText(chunk: unknown): string {
  if (!isRecord(chunk) || typeof chunk.type !== "string") {
    return "";
  }
  if (
    chunk.type === "response.output_text.done" ||
    chunk.type === "response.refusal.done" ||
    chunk.type === "text_end"
  ) {
    return typeof chunk.text === "string"
      ? chunk.text
      : typeof chunk.content === "string"
        ? chunk.content
        : "";
  }
  if (chunk.type !== "done" || !isRecord(chunk.message)) {
    return "";
  }
  return formatMessageContent(chunk.message.content ?? chunk.message.text);
}

function responseText(trace: LlmTraceDetail | null): string {
  const chunks = trace?.responseChunks;
  if (!Array.isArray(chunks)) {
    return "";
  }
  const visibleDeltas = chunks.map(visibleResponseDelta).join("");
  if (visibleDeltas) {
    return visibleDeltas;
  }
  return chunks.map(finalResponseText).filter(Boolean).at(-1) ?? "";
}

function matchesFilter(entry: LlmTraceSummary, needle: string): boolean {
  if (!needle) {
    return true;
  }
  const haystack = normalizeLowercaseStringOrEmpty(
    [
      entry.id,
      entry.runId,
      entry.sessionKey,
      entry.provider,
      entry.model,
      entry.api,
      entry.status,
      entry.errorCategory,
    ]
      .filter(Boolean)
      .join(" "),
  );
  return haystack.includes(needle);
}

function unavailableReason(capability: TraceCapability | null): string {
  if (!capability) {
    return "Tracing capability has not loaded yet.";
  }
  if (capability.reasons.length === 0) {
    return "Tracing is disabled.";
  }
  return capability.reasons.join(", ");
}

function renderTraceRows(
  entries: LlmTraceSummary[],
  selectedId: string | null,
  onSelect: (id: string) => void,
) {
  if (entries.length === 0) {
    return html`<div class="muted" style="padding: 14px;">No traces.</div>`;
  }
  return html`
    <div class="traces-table" role="list">
      ${entries.map(
        (entry) => html`
          <button
            class="traces-row ${entry.id === selectedId ? "selected" : ""}"
            data-traces-row=${entry.id}
            role="listitem"
            @click=${() => onSelect(entry.id)}
          >
            <span class="trace-main">
              <span class="trace-row-top">
                <span class="trace-name">${entry.provider}/${entry.model}</span>
                <span class="trace-status ${entry.status}">${entry.status}</span>
              </span>
              <span class="trace-meta mono">${entry.callId}</span>
              <span class="trace-row-facts">
                <span>${formatDuration(entry.durationMs)}</span>
                <span>${formatCount(entry.toolCount, "tool")}</span>
              </span>
            </span>
          </button>
        `,
      )}
    </div>
  `;
}

function renderMessages(trace: LlmTraceDetail | null) {
  const messages = requestMessages(trace);
  if (messages.length === 0) {
    const inputJson = formatJson(requestInputs(trace));
    return html`<pre class="mono traces-json" data-traces-request-payload>${inputJson}</pre>`;
  }
  return html`
    <div class="trace-message-list" data-traces-request-payload>
      ${messages.map(
        (message) => html`
          <article class="trace-message ${roleClassName(message.role)}">
            <div class="trace-message-header">
              <span>${message.role}${message.name ? `: ${message.name}` : ""}</span>
            </div>
            <pre class="trace-message-content">${message.content}</pre>
            <details class="trace-raw-disclosure">
              <summary>Raw message</summary>
              <pre class="mono traces-json compact">${formatJson(message.raw)}</pre>
            </details>
          </article>
        `,
      )}
    </div>
  `;
}

function renderToolArguments(tool: ReadableTool) {
  const properties = isRecord(tool.parameters?.properties) ? tool.parameters.properties : null;
  if (!properties || Object.keys(properties).length === 0) {
    const toolJson = formatJson(tool.parameters ?? tool.raw);
    return html`<pre class="mono traces-json compact">${toolJson}</pre>`;
  }
  return html`
    <div class="trace-tool-args">
      ${Object.entries(properties).map(([name, spec]) => {
        const specRecord = isRecord(spec) ? spec : {};
        const type = typeof specRecord.type === "string" ? specRecord.type : "value";
        const description =
          typeof specRecord.description === "string" && specRecord.description
            ? specRecord.description
            : "";
        return html`
          <div class="trace-tool-arg">
            <span class="mono">${name}</span>
            <span>${type}${tool.required.has(name) ? ", required" : ""}</span>
            <span>${description}</span>
          </div>
        `;
      })}
    </div>
  `;
}

function renderTools(trace: LlmTraceDetail | null) {
  const tools = requestReadableTools(trace);
  if (tools.length === 0) {
    return html`<div class="muted">No tools captured.</div>`;
  }
  return html`
    <div class="trace-tool-list" data-traces-tools>
      ${tools.map(
        (tool) => html`
          <details class="trace-tool" open>
            <summary>
              <span class="trace-tool-name">${tool.name}</span>
              ${tool.description ? html`<span>${tool.description}</span>` : nothing}
            </summary>
            ${renderToolArguments(tool)}
            <details class="trace-raw-disclosure">
              <summary>Raw schema</summary>
              <pre class="mono traces-json compact">${formatJson(tool.raw)}</pre>
            </details>
          </details>
        `,
      )}
    </div>
  `;
}

function renderParams(params: unknown) {
  if (!isRecord(params) || Object.keys(params).length === 0) {
    return html`<div class="muted">No invocation parameters captured.</div>`;
  }
  const paramsJson = formatJson(params);
  return html`
    <div>
      <div class="trace-param-list">
        ${Object.entries(params).map(
          ([key, value]) => html`
            <div class="trace-param">
              <span>${key}</span>
              <code>${typeof value === "string" ? value : formatJson(value)}</code>
            </div>
          `,
        )}
      </div>
      <details class="trace-raw-disclosure">
        <summary>Raw parameters</summary>
        <pre class="mono traces-json compact">${paramsJson}</pre>
      </details>
    </div>
  `;
}

function renderResponse(trace: LlmTraceDetail | null) {
  const text = responseText(trace);
  return html`
    ${text
      ? html`<pre class="trace-message-content response">${text}</pre>`
      : html`<div class="muted">No reconstructed response text captured.</div>`}
    <details class="trace-raw-disclosure">
      <summary>Raw response events</summary>
      <pre class="mono traces-json compact">${formatJson(trace?.responseChunks)}</pre>
    </details>
  `;
}

function renderTraceDetail(trace: LlmTraceDetail | null, capability: TraceCapability | null) {
  if (!trace) {
    return html`<div class="traces-detail-empty muted">Select a trace.</div>`;
  }
  const params = requestParams(trace);
  return html`
    <section class="traces-detail">
      <div class="traces-detail-header">
        <div>
          <div class="card-title">${trace.provider}/${trace.model}</div>
          <div class="card-sub mono">${trace.callId}</div>
        </div>
        <div class="trace-status ${trace.status}">${trace.status}</div>
      </div>
      <div class="traces-detail-meta">
        <span><strong>${formatDuration(trace.durationMs)}</strong> duration</span>
        <span><strong>${formatDuration(trace.timeToFirstByteMs)}</strong> TTFB</span>
        <span
          ><strong>${trace.toolCount ?? 0}</strong> ${trace.toolCount === 1
            ? "tool"
            : "tools"}</span
        >
        <span><strong>${formatBytes(trace.requestPayloadBytes)}</strong> request</span>
        <span><strong>${formatBytes(trace.responseStreamBytes)}</strong> response</span>
        <span>${formatTime(trace.startedAt)}</span>
      </div>
      ${capability?.payloadCaptureEnabled
        ? nothing
        : html`<div class="callout" style="margin-top: 12px;">
            Raw prompt and tool payload capture is disabled.
          </div>`}
      <div class="traces-detail-content">
        <section class="trace-panel trace-panel-primary">
          <div class="traces-section-title">Prompt messages</div>
          ${renderMessages(trace)}
        </section>
        <section class="trace-panel">
          <div class="traces-section-title">Tools</div>
          ${renderTools(trace)}
        </section>
        <section class="trace-panel">
          <div class="traces-section-title">Parameters</div>
          ${renderParams(params)}
        </section>
        <section class="trace-panel trace-panel-primary">
          <div class="traces-section-title">Response</div>
          ${renderResponse(trace)}
        </section>
        <section class="trace-panel trace-panel-primary">
          <details class="trace-raw-disclosure">
            <summary>Raw request payload</summary>
            <pre class="mono traces-json compact">${formatJson(trace.requestPayload)}</pre>
          </details>
        </section>
      </div>
    </section>
  `;
}

export function renderTraces(props: TracesProps) {
  const needle = normalizeLowercaseStringOrEmpty(props.filterText);
  const filtered = props.entries.filter((entry) => matchesFilter(entry, needle));
  const capability = props.capability;
  const available = capability?.available === true;

  return html`
    <section class="card traces-view">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Traces</div>
          <div class="card-sub">Development LLM request capture.</div>
        </div>
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? "Loading" : "Refresh"}
        </button>
      </div>

      <div class="filters" style="margin-top: 14px;">
        <label class="field" style="min-width: 260px;">
          <span>Filter</span>
          <input
            .value=${props.filterText}
            @input=${(e: Event) => props.onFilterTextChange((e.target as HTMLInputElement).value)}
            placeholder="Search traces"
          />
        </label>
      </div>

      ${props.error
        ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>`
        : nothing}
      ${!available
        ? html`<div class="callout" style="margin-top: 12px;">
            Tracing unavailable: ${unavailableReason(capability)}
          </div>`
        : nothing}

      <div class="traces-layout">
        <section class="traces-list">
          ${renderTraceRows(available ? filtered : [], props.selectedId, props.onSelect)}
        </section>
        ${renderTraceDetail(available ? props.selected : null, capability)}
      </div>
    </section>
  `;
}
