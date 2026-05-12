import { detectInlineEvalArgv } from "../command-analysis/risks.js";
import {
  analyzeArgvCommand,
  analyzeShellCommand,
  splitCommandChainWithOperators,
  type ExecCommandAnalysis,
  type ExecCommandSegment,
  type ShellChainOperator,
} from "../exec-approvals-analysis.js";
import { normalizeExecutableToken } from "../exec-wrapper-resolution.js";
import type {
  CommandAuthorizationContext,
  CommandAuthorizationInput,
  CommandAuthorizationPlan,
  CommandAuthorizationRelationship,
  CommandAuthorizationTree,
  CommandAuthorizationUnit,
  CommandDialect,
  CommandPromptOnlyReason,
  CommandUnanalyzableReason,
} from "./types.js";

type PlannedTree = {
  tree: CommandAuthorizationTree;
  units: CommandAuthorizationUnit[];
  nextUnitIndex: number;
};

type UnsupportedWrapper = {
  dialect: "windows-cmd" | "powershell";
  reason: CommandPromptOnlyReason;
};

export function planCommandForAuthorization(
  input: CommandAuthorizationInput,
  context: CommandAuthorizationContext = {},
): CommandAuthorizationPlan {
  if (input.dialect === "argv") {
    return planArgvCommand(input.argv, input.command, context);
  }
  if (input.dialect === "windows-cmd" || input.dialect === "powershell") {
    return planUnsupportedShellDialect(input.command, input.dialect);
  }
  return planPosixShellCommand(input.command, context);
}

function planArgvCommand(
  argvInput: readonly string[],
  command: string | undefined,
  context: CommandAuthorizationContext,
): CommandAuthorizationPlan {
  const source = command ?? argvInput.join(" ");
  const argv = argvInput.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (argv.length === 0) {
    return unanalyzablePlan(source, "argv", ["empty-argv"]);
  }

  const unsupportedWrapper = classifyUnsupportedWrapper(argv);
  if (unsupportedWrapper) {
    const unit = createUnit({
      id: "unit-0",
      raw: source,
      argv,
      relationship: "wrapper-inline",
      promptOnlyReasons: [unsupportedWrapper.reason],
    });
    return promptOnlyPlan(source, unsupportedWrapper.dialect, { kind: "unit", unitId: unit.id }, [
      unit,
    ]);
  }

  const analysis = analyzeArgvCommand({
    argv,
    cwd: context.cwd,
    env: context.env,
  });
  if (!analysis.ok) {
    return unanalyzablePlan(source, "argv", ["empty-argv"]);
  }
  return finalizePlannedTree(source, "argv", buildTreeFromSegments(analysis.segments, 0, "simple"));
}

function planUnsupportedShellDialect(
  command: string,
  dialect: "windows-cmd" | "powershell",
): CommandAuthorizationPlan {
  const source = command.trim();
  if (!source) {
    return unanalyzablePlan(command, dialect, ["empty-command"]);
  }
  const reason: CommandPromptOnlyReason =
    dialect === "powershell" ? "unsupported-powershell-wrapper" : "unsupported-cmd-wrapper";
  const unit = createUnit({
    id: "unit-0",
    raw: source,
    argv: [],
    relationship: "wrapper-inline",
    promptOnlyReasons: [reason],
  });
  return promptOnlyPlan(command, dialect, { kind: "unit", unitId: unit.id }, [unit]);
}

function planPosixShellCommand(
  command: string,
  context: CommandAuthorizationContext,
): CommandAuthorizationPlan {
  const source = command.trim();
  if (!source) {
    return unanalyzablePlan(command, "posix-shell", ["empty-command"]);
  }

  const commandSubstitution = detectCommandSubstitution(source);
  if (commandSubstitution) {
    const unit = createUnit({
      id: "unit-0",
      raw: source,
      argv: [],
      relationship: "simple",
      promptOnlyReasons: commandSubstitution,
    });
    return promptOnlyPlan(command, "posix-shell", { kind: "unit", unitId: unit.id }, [unit]);
  }

  const chainParts = splitCommandChainWithOperators(source);
  if (chainParts) {
    const operators: ShellChainOperator[] = [];
    const children: CommandAuthorizationTree[] = [];
    const units: CommandAuthorizationUnit[] = [];
    let nextUnitIndex = 0;
    let previousOperator: ShellChainOperator | null = null;

    for (const part of chainParts) {
      const partAnalysis = analyzeShellCommand({
        command: part.part,
        cwd: context.cwd,
        env: context.env,
        platform: context.platform,
      });
      if (!partAnalysis.ok) {
        return unanalyzableFromAnalysis(command, "posix-shell", partAnalysis);
      }
      const planned = buildTreeFromSegments(
        partAnalysis.segments,
        nextUnitIndex,
        relationshipForOperator(previousOperator),
      );
      nextUnitIndex = planned.nextUnitIndex;
      children.push(planned.tree);
      units.push(...planned.units);
      if (part.opToNext) {
        operators.push(part.opToNext);
      }
      previousOperator = part.opToNext;
    }

    return finalizePlannedTree(command, "posix-shell", {
      tree: { kind: "chain", operators, children },
      units,
      nextUnitIndex,
    });
  }

  const analysis = analyzeShellCommand({
    command: source,
    cwd: context.cwd,
    env: context.env,
    platform: context.platform,
  });
  if (!analysis.ok) {
    return unanalyzableFromAnalysis(command, "posix-shell", analysis);
  }
  return finalizePlannedTree(
    command,
    "posix-shell",
    buildTreeFromSegments(
      analysis.segments,
      0,
      analysis.segments.length > 1 ? "pipeline" : "simple",
    ),
  );
}

function buildTreeFromSegments(
  segments: readonly ExecCommandSegment[],
  startUnitIndex: number,
  relationship: CommandAuthorizationRelationship,
): PlannedTree {
  const units = segments.map((segment, offset) =>
    createUnitFromSegment(segment, `unit-${startUnitIndex + offset}`, relationship),
  );
  const children = units.map(
    (unit): CommandAuthorizationTree => ({ kind: "unit", unitId: unit.id }),
  );
  return {
    tree: children.length === 1 ? children[0] : { kind: "pipeline", children },
    units,
    nextUnitIndex: startUnitIndex + units.length,
  };
}

function createUnitFromSegment(
  segment: ExecCommandSegment,
  id: string,
  relationship: CommandAuthorizationRelationship,
): CommandAuthorizationUnit {
  const promptOnlyReasons: CommandPromptOnlyReason[] = [];
  if (detectInlineEvalArgv(segment.argv)) {
    promptOnlyReasons.push("interpreter-inline-eval");
  }
  return createUnit({
    id,
    raw: segment.raw,
    argv: segment.argv,
    relationship,
    promptOnlyReasons,
  });
}

function createUnit(params: {
  id: string;
  raw: string;
  argv: string[];
  relationship: CommandAuthorizationRelationship;
  promptOnlyReasons: CommandPromptOnlyReason[];
}): CommandAuthorizationUnit {
  const executable = params.argv[0]?.trim() || null;
  const normalizedExecutable = executable ? normalizeExecutableToken(executable) : null;
  const allowAutomatically = params.promptOnlyReasons.length === 0;
  return {
    id: params.id,
    raw: params.raw,
    argv: params.argv,
    executable,
    normalizedExecutable,
    relationship: params.relationship,
    allowlistEligible: allowAutomatically,
    allowAlwaysEligible: allowAutomatically,
    promptOnlyReasons: params.promptOnlyReasons,
    blockReasons: [],
  };
}

function finalizePlannedTree(
  source: string,
  dialect: CommandDialect,
  planned: PlannedTree,
): CommandAuthorizationPlan {
  const promptOnlyReasons = uniquePromptOnlyReasons(
    planned.units.flatMap((unit) => unit.promptOnlyReasons),
  );
  if (promptOnlyReasons.length > 0) {
    return promptOnlyPlan(source, dialect, planned.tree, planned.units);
  }
  return {
    kind: "analyzable",
    source,
    dialect,
    tree: planned.tree,
    units: planned.units,
  };
}

function promptOnlyPlan(
  source: string,
  dialect: CommandDialect,
  tree: CommandAuthorizationTree,
  units: CommandAuthorizationUnit[],
): CommandAuthorizationPlan {
  return {
    kind: "prompt-only",
    source,
    dialect,
    tree,
    units,
    promptOnlyReasons: uniquePromptOnlyReasons(units.flatMap((unit) => unit.promptOnlyReasons)),
  };
}

function unanalyzableFromAnalysis(
  source: string,
  dialect: CommandDialect,
  analysis: ExecCommandAnalysis,
): CommandAuthorizationPlan {
  const reason: CommandUnanalyzableReason =
    analysis.reason === "empty command" ? "empty-command" : "malformed-shell";
  return unanalyzablePlan(source, dialect, [reason]);
}

function unanalyzablePlan(
  source: string,
  dialect: CommandDialect,
  reasons: CommandUnanalyzableReason[],
): CommandAuthorizationPlan {
  return {
    kind: "unanalyzable",
    source,
    dialect,
    reasons,
  };
}

function relationshipForOperator(
  operator: ShellChainOperator | null,
): CommandAuthorizationRelationship {
  if (operator === "&&") {
    return "and-conditional";
  }
  if (operator === "||") {
    return "or-conditional";
  }
  if (operator === ";") {
    return "sequence";
  }
  return "simple";
}

function uniquePromptOnlyReasons(
  reasons: readonly CommandPromptOnlyReason[],
): CommandPromptOnlyReason[] {
  return [...new Set(reasons)];
}

function classifyUnsupportedWrapper(argv: readonly string[]): UnsupportedWrapper | null {
  const executable = normalizeExecutableToken(argv[0] ?? "");
  if (executable === "cmd" || executable === "cmd.exe") {
    return { dialect: "windows-cmd", reason: "unsupported-cmd-wrapper" };
  }
  if (executable === "powershell" || executable === "powershell.exe" || executable === "pwsh") {
    return { dialect: "powershell", reason: "unsupported-powershell-wrapper" };
  }
  return null;
}

function detectCommandSubstitution(command: string): CommandPromptOnlyReason[] | null {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (!inSingle && ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle) {
      continue;
    }
    if ((ch === "$" && command[index + 1] === "(") || ch === "`") {
      const reasons: CommandPromptOnlyReason[] = ["command-substitution"];
      if (isDynamicExecutablePosition(command, index)) {
        reasons.push("dynamic-executable");
      }
      return reasons;
    }
  }

  return null;
}

function isDynamicExecutablePosition(command: string, substitutionIndex: number): boolean {
  const before = command.slice(0, substitutionIndex).trim();
  return before.length === 0 || /(?:^|[;&|])\s*$/.test(before);
}
