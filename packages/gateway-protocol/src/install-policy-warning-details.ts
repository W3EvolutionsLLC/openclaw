export type InstallPolicyWarningFinding = {
  ruleId: string;
  severity: "info" | "warn" | "critical";
  message: string;
  file?: string;
  line?: number;
  evidence?: string;
};

export const INSTALL_POLICY_ACKNOWLEDGEMENT_TOKEN_MAX_CHARS = 65_536;

export type InstallPolicyWarningDetails = {
  installPolicyWarning: {
    reason: string;
    findings?: InstallPolicyWarningFinding[];
    acknowledgementId?: string;
  };
};

function findingLocation(
  finding: InstallPolicyWarningFinding,
  formatText: (value: string) => string,
): string | undefined {
  if (finding.file) {
    return `${formatText(finding.file)}${finding.line ? `:${finding.line}` : ""}`;
  }
  return finding.line ? `line ${finding.line}` : undefined;
}

function formatFinding(
  finding: InstallPolicyWarningFinding,
  formatText: (value: string) => string,
): string {
  const context = [
    finding.severity.toUpperCase(),
    formatText(finding.ruleId),
    findingLocation(finding, formatText),
  ].filter(Boolean);
  const summary = `• [${context.join(" · ")}] ${formatText(finding.message)}`;
  return finding.evidence ? `${summary}\n  ↳ ${formatText(finding.evidence)}` : summary;
}

export function formatInstallPolicyWarningDetails(
  warning: InstallPolicyWarningDetails["installPolicyWarning"],
  formatText: (value: string) => string = (value) => value,
): string {
  return [
    formatText(warning.reason),
    ...(warning.findings ?? []).map((finding) => formatFinding(finding, formatText)),
  ].join("\n");
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readFinding(value: unknown): InstallPolicyWarningFinding | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const ruleId = normalizeNonEmptyString(raw.ruleId);
  const message = normalizeNonEmptyString(raw.message);
  if (
    !ruleId ||
    !message ||
    (raw.severity !== "info" && raw.severity !== "warn" && raw.severity !== "critical")
  ) {
    return undefined;
  }
  const file = normalizeNonEmptyString(raw.file);
  const evidence = normalizeNonEmptyString(raw.evidence);
  const line =
    typeof raw.line === "number" && Number.isInteger(raw.line) && raw.line > 0
      ? raw.line
      : undefined;
  return {
    ruleId,
    severity: raw.severity,
    message,
    ...(file ? { file } : {}),
    ...(line ? { line } : {}),
    ...(evidence ? { evidence } : {}),
  };
}

export function buildInstallPolicyWarningDetails(params: {
  warning?: InstallPolicyWarningDetails["installPolicyWarning"];
}): InstallPolicyWarningDetails | undefined {
  return params.warning ? { installPolicyWarning: params.warning } : undefined;
}

export function readInstallPolicyWarningDetails(
  details: unknown,
): InstallPolicyWarningDetails | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return undefined;
  }
  const warning = (details as { installPolicyWarning?: unknown }).installPolicyWarning;
  if (!warning || typeof warning !== "object" || Array.isArray(warning)) {
    return undefined;
  }
  const raw = warning as Record<string, unknown>;
  const reason = normalizeNonEmptyString(raw.reason);
  if (!reason) {
    return undefined;
  }
  const acknowledgementId = normalizeNonEmptyString(raw.acknowledgementId);
  const findings = Array.isArray(raw.findings)
    ? raw.findings
        .slice(0, 100)
        .map(readFinding)
        .filter((finding): finding is InstallPolicyWarningFinding => Boolean(finding))
    : [];
  return {
    installPolicyWarning: {
      reason,
      ...(findings.length > 0 ? { findings } : {}),
      ...(acknowledgementId &&
      acknowledgementId.length <= INSTALL_POLICY_ACKNOWLEDGEMENT_TOKEN_MAX_CHARS
        ? { acknowledgementId }
        : {}),
    },
  };
}
