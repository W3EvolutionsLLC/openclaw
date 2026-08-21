import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { t } from "../../i18n/index.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { modelProviderErrorMessage } from "./config-mutation.ts";
import {
  buildModelProviderCards,
  readModelProviderConfig,
  type ModelProviderCard,
} from "./data.ts";
import type { ModelProvidersData } from "./load.ts";
import type { ModelProviderRowMessage } from "./view.ts";

export type ProfileOrderDrafts = Record<string, string[]>;

type AuthoritativeProfileOrder =
  | { state: "available"; order: string[] | null }
  | { state: "missing" }
  | { state: "unavailable" };

type ProfileOrderHost = {
  snapshot: () => ApplicationGatewaySnapshot;
  current: () => { agentEpoch: number; agentId: string; clientEpoch: number };
  canMutate: () => boolean;
  isBusy: (key: string) => boolean;
  isCurrentClient: (client: GatewayBrowserClient, clientEpoch: number) => boolean;
  prepareForMutation: (agentId: string) => void;
  refresh: () => Promise<void>;
  clearProbe: (cardId: string) => void;
  getData: () => ModelProvidersData | null;
  setData: (data: ModelProvidersData) => void;
  getDrafts: () => ProfileOrderDrafts;
  setDrafts: (drafts: ProfileOrderDrafts) => void;
  setBusy: (key: string, value: boolean) => void;
  setMessage: (key: string, message: ModelProviderRowMessage | null) => void;
};

export function canMutateProviderProfiles(
  snapshot: ApplicationGatewaySnapshot,
  agentId: string,
): boolean {
  return (
    snapshot.phase === "connected" &&
    Boolean(snapshot.client) &&
    Boolean(agentId) &&
    hasOperatorAdminAccess(snapshot.hello?.auth ?? null)
  );
}

function sameProfileOrder(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((profileId, index) => profileId === right[index])
  );
}

function buildCards(data: ModelProvidersData, config: ReturnType<typeof readModelProviderConfig>) {
  return buildModelProviderCards({
    ...data,
    providerUsage: data.providerUsage?.ok ? data.providerUsage.value : null,
    configProviderIds: config.providerIds,
    configApiKeyProviderIds: config.apiKeyProviderIds,
    configProviderAuthModes: config.providerAuthModes,
  });
}

function reconcileDraft(card: ModelProviderCard, provider: string, draft: string[]): string[] {
  const membership = card.profileOwnerProfileIds[provider];
  if (!membership || draft.length === 0) {
    return draft;
  }
  const authoritativeIds = new Set(membership);
  const retainedDraft = draft.filter((profileId) => authoritativeIds.has(profileId));
  const refreshedOrder = card.profileOrders[provider] ?? membership;
  const draftIds = new Set(draft);
  let reorderedIndex = 0;
  // Fresh authoritative order owns added/removed slots; retain the queued
  // relative order for profiles that still exist so a retry cannot lose a
  // newly logged-in account.
  const reconciled = refreshedOrder.map((profileId) =>
    draftIds.has(profileId) ? (retainedDraft[reorderedIndex++] ?? profileId) : profileId,
  );
  return [...reconciled, ...retainedDraft.slice(reorderedIndex)];
}

export class ProfileOrderController {
  private saves = new Map<string, Promise<void>>();
  private observedMemberships = new Map<string, string[]>();
  private draftProviders = new Map<string, string>();
  private logoutConfirmation: AbortController | null = null;

  constructor(private readonly host: ProfileOrderHost) {}

  reset() {
    this.logoutConfirmation?.abort();
    this.logoutConfirmation = null;
    this.saves = new Map();
    this.observedMemberships = new Map();
    this.draftProviders = new Map();
    this.host.setDrafts({});
  }

  async requestLogout(
    cardId: string,
    provider: string,
    owner: string,
    profileId: string,
    label: string,
    success: string,
  ) {
    const client = this.host.snapshot().client;
    if (!client) {
      return;
    }
    const { agentEpoch, clientEpoch } = this.host.current();
    const controller = new AbortController();
    this.logoutConfirmation?.abort();
    this.logoutConfirmation = controller;
    try {
      const confirmed = await showConfirmDialog({
        title: t("modelProviders.logout.profileTitle"),
        message: t("modelProviders.logout.profileConfirm", { account: label }),
        confirmLabel: t("modelProviders.logout.action"),
        danger: true,
        signal: controller.signal,
      });
      if (confirmed && this.isCurrent(client, clientEpoch, agentEpoch)) {
        await this.logout(cardId, provider, owner, profileId, success);
      }
    } finally {
      if (this.logoutConfirmation === controller) {
        this.logoutConfirmation = null;
      }
    }
  }

  waitFor(provider: string): Promise<void> | undefined {
    return this.saves.get(this.saveKey(provider));
  }

  applyData(data: ModelProvidersData) {
    const cards = buildCards(data, readModelProviderConfig(data.config));
    let changed = false;
    const nextDrafts = Object.fromEntries(
      Object.entries(this.host.getDrafts()).map(([provider, draft]) => {
        const card = cards.find((candidate) => candidate.profileOwnerProfileIds[provider]);
        if (!card) {
          return [provider, draft];
        }
        const next = reconcileDraft(card, provider, draft);
        const membership = card.profileOwnerProfileIds[provider];
        if (membership) {
          this.observedMemberships.set(provider, [...membership]);
        }
        changed ||= !sameProfileOrder(next, draft);
        return [provider, next];
      }),
    );
    if (changed) {
      this.host.setDrafts(nextDrafts);
    }
    this.host.setData(data);
    if (data.authStatus) {
      for (const [provider, draft] of Object.entries(this.host.getDrafts())) {
        if (!this.saves.has(this.saveKey(provider))) {
          this.queue(this.draftProviders.get(provider) ?? provider, draft);
        }
      }
    }
  }

  buildCards(
    data: ModelProvidersData,
    config: ReturnType<typeof readModelProviderConfig>,
  ): ModelProviderCard[] {
    const cards: ModelProviderCard[] = [];
    for (const card of buildCards(data, config)) {
      const drafts = Object.fromEntries(
        Object.entries(this.host.getDrafts())
          .filter(([provider]) => card.profileOwnerProfileIds[provider])
          .map(([provider, draft]) => [provider, reconcileDraft(card, provider, draft)]),
      );
      if (Object.keys(drafts).length === 0) {
        cards.push(card);
        continue;
      }
      const profileOrder = [...card.profileOrder];
      for (const profile of card.profiles) {
        if (!profileOrder.includes(profile.profileId)) {
          profileOrder.push(profile.profileId);
        }
      }
      const profileOrders = { ...card.profileOrders };
      for (const [provider, draft] of Object.entries(drafts)) {
        const ownerIds = new Set(draft);
        let draftIndex = 0;
        for (let index = 0; index < profileOrder.length; index += 1) {
          if (ownerIds.has(profileOrder[index]!)) {
            profileOrder[index] = draft[draftIndex++] ?? profileOrder[index]!;
          }
        }
        profileOrders[provider] = draft;
      }
      cards.push({ ...card, profileOrder, profileOrders });
    }
    return cards;
  }

  async logout(
    cardId: string,
    provider: string,
    owner: string,
    profileId: string,
    success: string,
  ) {
    const client = this.host.snapshot().client;
    const key = `logout:${owner}`;
    if (!client || !this.host.canMutate() || this.host.isBusy(key)) {
      return;
    }
    const { agentEpoch, agentId, clientEpoch } = this.host.current();
    // Membership changes must follow this owner's queued order writes. Otherwise
    // a late order commit can restore the id that logout just removed.
    await this.waitFor(owner);
    if (!this.isCurrent(client, clientEpoch, agentEpoch)) {
      return;
    }
    this.host.clearProbe(cardId);
    this.host.setBusy(key, true);
    this.host.setMessage(`profiles:${owner}`, null);
    try {
      await client.request("models.authLogout", { provider, profileIds: [profileId], agentId });
      if (!this.isCurrent(client, clientEpoch, agentEpoch)) {
        return;
      }
      await this.refreshAfterCommit({
        messageKey: `profiles:${owner}`,
        success,
        client,
        clientEpoch,
        agentEpoch,
      });
    } catch (error) {
      if (this.isCurrent(client, clientEpoch, agentEpoch)) {
        this.host.setMessage(`profiles:${owner}`, {
          kind: "error",
          text: modelProviderErrorMessage(error),
        });
      }
    } finally {
      if (this.isCurrent(client, clientEpoch, agentEpoch)) {
        this.host.setBusy(key, false);
      }
    }
  }

  async mutate(
    messageKey: string,
    method: "models.authOrderSet" | "models.authCooldownClear",
    params: Record<string, unknown>,
    success: string,
    busyKey = messageKey,
  ) {
    const snapshot = this.host.snapshot();
    const client = snapshot.client;
    if (
      !client ||
      !this.host.canMutate() ||
      this.host.isBusy(busyKey) ||
      isGatewayMethodAdvertised(snapshot, method) === false
    ) {
      return;
    }
    const { agentEpoch, agentId, clientEpoch } = this.host.current();
    this.host.setBusy(busyKey, true);
    this.host.setMessage(messageKey, null);
    try {
      try {
        await client.request(method, { ...params, agentId });
      } catch (error) {
        if (this.isCurrent(client, clientEpoch, agentEpoch)) {
          this.host.setMessage(messageKey, {
            kind: "error",
            text: modelProviderErrorMessage(error),
          });
        }
        return;
      }
      if (!this.isCurrent(client, clientEpoch, agentEpoch)) {
        return;
      }
      await this.refreshAfterCommit({
        messageKey,
        success,
        client,
        clientEpoch,
        agentEpoch,
      });
    } finally {
      if (this.isCurrent(client, clientEpoch, agentEpoch)) {
        this.host.setBusy(busyKey, false);
      }
    }
  }

  queue(provider: string, profileIds: string[]) {
    if (profileIds.length === 0) {
      return;
    }
    const snapshot = this.host.snapshot();
    const client = snapshot.client;
    const owner = this.canonicalOwner(provider);
    if (
      !client ||
      !this.host.canMutate() ||
      !owner ||
      isGatewayMethodAdvertised(snapshot, "models.authOrderSet") === false
    ) {
      return;
    }
    const { agentEpoch, agentId, clientEpoch } = this.host.current();
    const saveKey = this.saveKey(owner);
    const observedMembership = this.observedMembership(owner);
    if (!observedMembership) {
      return;
    }
    this.host.prepareForMutation(agentId);
    this.observedMemberships.set(owner, observedMembership);
    this.draftProviders.set(owner, provider);
    this.setDraft(owner, profileIds);
    this.host.setMessage(`profiles:${owner}`, null);
    if (this.saves.has(saveKey)) {
      return;
    }

    this.host.setBusy(`profiles:${owner}`, true);
    const save = this.flush({ owner, client, clientEpoch, agentEpoch, agentId }).finally(() => {
      if (this.saves.get(saveKey) === save) {
        this.saves.delete(saveKey);
        if (this.isCurrent(client, clientEpoch, agentEpoch)) {
          this.host.setBusy(`profiles:${owner}`, false);
        }
      }
    });
    this.saves.set(saveKey, save);
  }

  private saveKey(provider: string): string {
    const { agentEpoch, clientEpoch } = this.host.current();
    return `${clientEpoch}:${agentEpoch}:${provider}`;
  }

  private canonicalOwner(provider: string): string | null {
    const rows = this.host.getData()?.authStatus?.providers;
    const row =
      rows?.find((candidate) => candidate.provider === provider) ??
      rows?.find((candidate) => (candidate.authProvider ?? candidate.provider) === provider);
    return row ? (row.authProvider ?? row.provider) : null;
  }

  private observedMembership(provider: string): string[] | null {
    const data = this.host.getData();
    if (!data) {
      return null;
    }
    const card = buildCards(data, readModelProviderConfig(data.config)).find(
      (candidate) => candidate.profileOwnerProfileIds[provider] !== undefined,
    );
    const membership = card?.profileOwnerProfileIds[provider];
    return membership ? [...membership] : null;
  }

  private isCurrent(client: GatewayBrowserClient, clientEpoch: number, agentEpoch: number) {
    return (
      this.host.isCurrentClient(client, clientEpoch) &&
      this.host.current().agentEpoch === agentEpoch
    );
  }

  private setDraft(provider: string, profileIds: string[] | null) {
    const drafts = this.host.getDrafts();
    const next = { ...drafts };
    if (profileIds) {
      next[provider] = [...profileIds];
    } else {
      delete next[provider];
    }
    this.host.setDrafts(next);
  }

  private commit(provider: string, profileIds: string[]) {
    const data = this.host.getData();
    const authStatus = data?.authStatus;
    if (!data || !authStatus) {
      return;
    }
    const providers = [];
    for (const row of authStatus.providers) {
      if ((row.authProvider ?? row.provider) !== provider) {
        providers.push(row);
      } else {
        providers.push({ ...row, profileOrder: [...profileIds] });
      }
    }
    this.host.setData({ ...data, authStatus: { ...authStatus, providers } });
  }

  private async flush(params: {
    owner: string;
    client: GatewayBrowserClient;
    clientEpoch: number;
    agentEpoch: number;
    agentId: string;
  }) {
    const { owner, client, clientEpoch, agentEpoch, agentId } = params;
    while (this.isCurrent(client, clientEpoch, agentEpoch)) {
      const provider = this.draftProviders.get(owner) ?? owner;
      const profileIds = this.host.getDrafts()[owner];
      const expectedProfileMembership = this.observedMemberships.get(owner);
      if (!profileIds || !expectedProfileMembership) {
        return;
      }
      try {
        await client.request("models.authOrderSet", {
          provider,
          profileIds,
          expectedProfileIds: this.savedOrder(owner, provider),
          expectedProfileMembership,
          agentId,
        });
      } catch (error) {
        if (!this.isCurrent(client, clientEpoch, agentEpoch)) {
          return;
        }
        let refreshed = false;
        try {
          await this.host.refresh();
          refreshed = true;
        } catch {
          // A disconnected refresh cannot tell whether the write committed.
          // Keep the optimistic draft so reconnect can reconcile and retry it.
        }
        if (!this.isCurrent(client, clientEpoch, agentEpoch)) {
          return;
        }
        const latest = this.host.getDrafts()[owner];
        const authoritative = refreshed
          ? this.authoritativeOrder(owner, provider)
          : ({ state: "unavailable" } as const);
        if (latest && !sameProfileOrder(latest, profileIds)) {
          if (authoritative.state === "available") {
            continue;
          }
          if (authoritative.state === "unavailable") {
            this.host.setMessage(`profiles:${owner}`, {
              kind: "error",
              text: modelProviderErrorMessage(error),
            });
            return;
          }
        }
        if (
          latest &&
          authoritative.state === "available" &&
          authoritative.order !== null &&
          sameProfileOrder(authoritative.order, profileIds)
        ) {
          this.clearDraft(owner);
          return;
        }
        if (authoritative.state !== "unavailable") {
          this.clearDraft(owner);
        }
        this.host.setMessage(`profiles:${owner}`, {
          kind: "error",
          text: modelProviderErrorMessage(error),
        });
        return;
      }
      if (!this.isCurrent(client, clientEpoch, agentEpoch)) {
        return;
      }
      // Supersede any refresh started after this write was dispatched. Its
      // pre-ACK snapshot must not replace the acknowledged order in the UI.
      this.host.prepareForMutation(agentId);
      // Record every acknowledged order underneath the optimistic draft. If a
      // newer queued order fails, rollback must reveal the last saved order.
      this.commit(owner, profileIds);
      const latest = this.host.getDrafts()[owner];
      if (!latest || !sameProfileOrder(latest, profileIds)) {
        continue;
      }
      this.clearDraft(owner);
      await this.refreshAfterCommit({
        messageKey: `profiles:${owner}`,
        client,
        clientEpoch,
        agentEpoch,
      });
      return;
    }
  }

  private async refreshAfterCommit(params: {
    messageKey: string;
    success?: string;
    client: GatewayBrowserClient;
    clientEpoch: number;
    agentEpoch: number;
  }) {
    let warning: string | null = null;
    try {
      await this.host.refresh();
    } catch (error) {
      // The mutation is already committed. A refresh failure can leave status
      // stale, but must not claim the account action itself failed.
      warning = modelProviderErrorMessage(error);
    }
    if (!this.isCurrent(params.client, params.clientEpoch, params.agentEpoch)) {
      return;
    }
    if (params.success !== undefined) {
      this.host.setMessage(params.messageKey, {
        kind: "success",
        text: params.success,
        ...(warning ? { warning } : {}),
      });
    } else if (warning) {
      this.host.setMessage(params.messageKey, { kind: "warning", text: warning });
    }
  }

  private clearDraft(owner: string) {
    this.setDraft(owner, null);
    this.observedMemberships.delete(owner);
    this.draftProviders.delete(owner);
  }

  private savedOrder(owner: string, provider: string): string[] | null {
    const authoritative = this.authoritativeOrder(owner, provider);
    return authoritative.state === "available" ? authoritative.order : null;
  }

  private authoritativeOrder(owner: string, provider: string): AuthoritativeProfileOrder {
    const authStatus = this.host.getData()?.authStatus;
    if (!authStatus) {
      return { state: "unavailable" };
    }
    const row =
      authStatus.providers.find(
        (candidate) =>
          candidate.provider === provider &&
          (candidate.authProvider ?? candidate.provider) === owner,
      ) ??
      authStatus.providers.find(
        (candidate) => (candidate.authProvider ?? candidate.provider) === owner,
      );
    if (!row) {
      return { state: "missing" };
    }
    return {
      state: "available",
      order: row.profileOrder ? [...row.profileOrder] : null,
    };
  }
}
