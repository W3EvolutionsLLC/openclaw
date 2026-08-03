import {
  createPluginSetupWizardConfigure,
  createTestWizardPrompter,
  runSetupWizardConfigure,
  runSetupWizardPrepare,
  type WizardPrompter,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { detectBinary } from "openclaw/plugin-sdk/setup-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signalSetupPlugin } from "./channel.setup.js";
import { installSignalCli } from "./install-signal-cli.js";
import { SIGNAL_LINK_COMPLETED_INPUT_KEY, SIGNAL_LINKED_ACCOUNT_INPUT_KEY } from "./setup-core.js";
import { signalSetupWizard } from "./setup-surface.js";
import { linkSignalCliAccount } from "./signal-cli-link.js";

vi.mock("openclaw/plugin-sdk/setup-tools", async (importOriginal) => {
  const original = await importOriginal<typeof import("openclaw/plugin-sdk/setup-tools")>();
  return { ...original, detectBinary: vi.fn() };
});
vi.mock("./install-signal-cli.js", () => ({ installSignalCli: vi.fn() }));
vi.mock("./signal-cli-link.js", () => ({ linkSignalCliAccount: vi.fn() }));

const detectBinaryMock = vi.mocked(detectBinary);
const installSignalCliMock = vi.mocked(installSignalCli);
const linkSignalCliAccountMock = vi.mocked(linkSignalCliAccount);

function createConfig(account?: string) {
  return {
    channels: {
      signal: {
        ...(account ? { account } : {}),
        transport: {
          kind: "managed-native" as const,
          cliPath: "/opt/signal-cli",
          configPath: "~/.local/share/signal-cli",
        },
      },
    },
  };
}

function createQrPrompter(params?: {
  confirmValues?: boolean[];
  qrCode?: WizardPrompter["qrCode"];
}) {
  const confirmValues = [...(params?.confirmValues ?? [false, true])];
  return createTestWizardPrompter({
    confirm: vi.fn(async () => confirmValues.shift() ?? false),
    qrCode: params?.qrCode ?? vi.fn(async () => true),
  });
}

type PrepareParams = Parameters<typeof runSetupWizardPrepare>[0];
type ConfigureParams = Parameters<typeof runSetupWizardConfigure>[0];

function prepare(
  params: {
    accountId?: string;
    cfg?: PrepareParams["cfg"];
    options?: PrepareParams["options"];
    prompter?: WizardPrompter;
  } = {},
) {
  return runSetupWizardPrepare({
    prepare: signalSetupWizard.prepare,
    cfg: params.cfg ?? createConfig(),
    ...(params.accountId ? { accountId: params.accountId } : {}),
    prompter: params.prompter ?? createQrPrompter(),
    options: params.options ?? { allowSignalInstall: true },
  });
}

function configure(
  params: {
    accountId?: string;
    cfg?: ConfigureParams["cfg"];
    options?: ConfigureParams["options"];
    prompter?: WizardPrompter;
  } = {},
) {
  return runSetupWizardConfigure({
    configure: createPluginSetupWizardConfigure(signalSetupPlugin),
    cfg: params.cfg ?? createConfig(),
    prompter: params.prompter ?? createQrPrompter(),
    accountOverrides: params.accountId ? { signal: params.accountId } : {},
    options: params.options ?? {
      allowSignalInstall: true,
      skipConfirm: true,
      skipDmPolicyPrompt: true,
    },
  });
}

function linkedCredentials(signalNumber = "+15555550123") {
  return {
    credentialValues: {
      signalNumber,
      signalLinkedAccount: "true",
      signalLinkCompleted: "true",
    },
  };
}

beforeEach(() => {
  detectBinaryMock.mockReset();
  detectBinaryMock.mockResolvedValue(true);
  installSignalCliMock.mockReset();
  linkSignalCliAccountMock.mockReset();
  linkSignalCliAccountMock.mockResolvedValue({
    ok: true,
    associatedAccount: "+15555550123",
  });
});

describe("signalSetupWizard QR linking", () => {
  it("presents the generic QR, waits for signal-cli, and persists the linked account", async () => {
    let finishLink!: () => void;
    const completion = new Promise<void>((resolve) => {
      finishLink = resolve;
    });
    const qrCode = vi.fn(async () => true);
    const beforePersistentEffect = vi.fn(async () => undefined);
    const abortController = new AbortController();
    linkSignalCliAccountMock.mockImplementationOnce(async ({ onLinkUri }) => {
      await onLinkUri("sgnl://linkdevice?uuid=test&pub_key=test", completion, 1_800_000_120_000);
      return { ok: true, associatedAccount: "+15555550123" };
    });

    const resultPromise = configure({
      prompter: createQrPrompter({ qrCode }),
      options: {
        allowSignalInstall: true,
        skipConfirm: true,
        skipDmPolicyPrompt: true,
        beforePersistentEffect,
        abortSignal: abortController.signal,
      },
    });

    await vi.waitFor(() => expect(qrCode).toHaveBeenCalledOnce());
    expect(linkSignalCliAccountMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cliPath: "/opt/signal-cli",
        configPath: "~/.local/share/signal-cli",
        signal: abortController.signal,
      }),
    );
    expect(qrCode).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "sgnl://linkdevice?uuid=test&pub_key=test",
        dismissed: completion,
        expiresAtMs: 1_800_000_120_000,
      }),
    );
    expect(beforePersistentEffect).toHaveBeenCalledOnce();

    finishLink();
    await expect(resultPromise).resolves.toMatchObject({
      cfg: { channels: { signal: { account: "+15555550123" } } },
    });
  });

  it("does not link when setup cannot or should not present a QR", async () => {
    expect(await prepare({ options: { allowSignalInstall: false } })).toBeUndefined();
    expect(
      await prepare({
        cfg: createConfig("+15555550123"),
        prompter: createQrPrompter({ confirmValues: [false, false] }),
      }),
    ).toBeUndefined();

    detectBinaryMock.mockResolvedValue(false);
    expect(
      await prepare({ prompter: createQrPrompter({ confirmValues: [false] }) }),
    ).toBeUndefined();
    expect(linkSignalCliAccountMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "a failed link",
      linkResult: { ok: false as const, error: "Link request timed out" },
      note: "Link request timed out",
    },
    {
      name: "a linked account that signal-cli did not identify",
      linkResult: { ok: true as const },
      note: "signal-cli linked successfully, but OpenClaw could not identify the linked account. Enter its Signal number to finish setup.",
    },
  ])("accepts a manual number after $name", async ({ linkResult, note: expectedNote }) => {
    linkSignalCliAccountMock.mockResolvedValueOnce(linkResult);
    const note = vi.fn(async () => undefined);
    const text = vi.fn(async () => "+15555550199");

    const result = await configure({ prompter: { ...createQrPrompter(), note, text } });

    expect(result.cfg.channels?.signal?.account).toBe("+15555550199");
    expect(text).toHaveBeenCalledOnce();
    expect(note).toHaveBeenCalledWith(expectedNote, "Signal account linking");
  });

  it("preserves a successful linked account when cancellation races completion", async () => {
    const abortController = new AbortController();
    const cancelled = new Error("setup cancelled");
    linkSignalCliAccountMock.mockImplementationOnce(async () => {
      abortController.abort(cancelled);
      return { ok: true, associatedAccount: "+15555550123" };
    });

    await expect(
      prepare({
        prompter: createQrPrompter(),
        options: { allowSignalInstall: true, abortSignal: abortController.signal },
      }),
    ).resolves.toEqual({
      credentialValues: {
        [SIGNAL_LINK_COMPLETED_INPUT_KEY]: "true",
        [SIGNAL_LINKED_ACCOUNT_INPUT_KEY]: "true",
        signalNumber: "+15555550123",
      },
    });
  });

  it.each([
    { name: "installation", detected: false, confirms: [true], installCalls: 0 },
    { name: "linking", detected: true, confirms: [false, true], installCalls: 0 },
  ])("guards $name before its persistent effect", async ({ detected, confirms, installCalls }) => {
    detectBinaryMock.mockResolvedValue(detected);
    const blocked = new Error("inference authorization failed");

    await expect(
      prepare({
        prompter: createQrPrompter({ confirmValues: confirms }),
        options: {
          allowSignalInstall: true,
          beforePersistentEffect: vi.fn(async () => {
            throw blocked;
          }),
        },
      }),
    ).rejects.toBe(blocked);
    expect(installSignalCliMock).toHaveBeenCalledTimes(installCalls);
    expect(linkSignalCliAccountMock).not.toHaveBeenCalled();
  });

  it("reauthorizes linking after installing signal-cli", async () => {
    detectBinaryMock.mockResolvedValue(false);
    installSignalCliMock.mockResolvedValue({ ok: true, cliPath: "/managed/signal-cli" });
    const blocked = new Error("inference authorization failed");
    const beforePersistentEffect = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(blocked);

    await expect(
      prepare({
        prompter: createQrPrompter({ confirmValues: [true, true] }),
        options: { allowSignalInstall: true, beforePersistentEffect },
      }),
    ).rejects.toBe(blocked);
    expect(beforePersistentEffect).toHaveBeenCalledTimes(2);
    expect(installSignalCliMock).toHaveBeenCalledOnce();
    expect(linkSignalCliAccountMock).not.toHaveBeenCalled();
  });

  it("links a named account without changing its configured sibling", async () => {
    linkSignalCliAccountMock.mockResolvedValueOnce({
      ok: true,
      associatedAccount: "+15555550444",
    });
    const transport = {
      kind: "managed-native" as const,
      cliPath: "/opt/signal-cli",
      configPath: "~/.local/share/signal-cli",
    };
    const cfg = {
      channels: {
        signal: {
          defaultAccount: "default",
          accounts: {
            default: { account: "+15555550123", transport },
            work: { transport },
          },
        },
      },
    };

    const result = await configure({ cfg, accountId: "work" });

    expect(result.cfg.channels?.signal?.accounts?.default?.account).toBe("+15555550123");
    expect(result.cfg.channels?.signal?.accounts?.work?.account).toBe("+15555550444");
  });

  it("finishes setup when signal-cli completes before the QR is acknowledged", async () => {
    const qrCode = vi.fn(async (params: Parameters<NonNullable<WizardPrompter["qrCode"]>>[0]) => {
      await params.dismissed;
      return true;
    });
    linkSignalCliAccountMock.mockImplementationOnce(async ({ onLinkUri }) => {
      await onLinkUri(
        "sgnl://linkdevice?uuid=test&pub_key=test",
        Promise.resolve(),
        Date.now() + 120_000,
      );
      return { ok: true, associatedAccount: "+15555550123" };
    });

    await expect(prepare({ prompter: createQrPrompter({ qrCode }) })).resolves.toEqual(
      linkedCredentials(),
    );
    expect(qrCode).toHaveBeenCalledOnce();
  });
});
