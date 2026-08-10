#!/usr/bin/env node

// Ensures ingress agent command callsites pass explicit owner context.
import ts from "typescript";
import { bundledPluginFile } from "./lib/bundled-plugin-paths.mjs";
import { runCallsiteGuard } from "./lib/callsite-guard.mts";
import {
  collectCallExpressionLines,
  runAsScript,
  unwrapExpression,
} from "./lib/ts-guard-utils.mts";

const sourceRoots = [
  "src",
  bundledPluginFile("discord", "src/voice"),
  "scripts/e2e/lib/codex-npm-plugin-live",
];

/**
 * Finds public ingress calls that still try to assert owner authority.
 */
function findIngressOwnerAssertionLines(content: string, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  return collectCallExpressionLines(ts, sourceFile, (node) => {
    const callee = unwrapExpression(node.expression);
    if (!ts.isIdentifier(callee) || callee.text !== "agentCommandFromIngress") {
      return null;
    }
    const input = node.arguments[0] ? unwrapExpression(node.arguments[0]) : undefined;
    if (!input || !ts.isObjectLiteralExpression(input)) {
      return null;
    }
    const ownerProperty = input.properties.find((property) => {
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
        return false;
      }
      const name = property.name;
      return (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === "senderIsOwner";
    });
    return ownerProperty?.name ?? null;
  });
}

/**
 * Runs the ingress owner-context guard.
 */
async function main() {
  await runCallsiteGuard({
    importMetaUrl: import.meta.url,
    sourceRoots,
    findCallLines: findIngressOwnerAssertionLines,
    header: "Found public ingress callsites asserting owner authority:",
    footer: "Owner authority must come from a host-minted execution identity admission.",
  });
}

runAsScript(import.meta.url, main);
