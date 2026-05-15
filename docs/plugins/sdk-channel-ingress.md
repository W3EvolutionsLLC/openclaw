---
summary: "Experimental channel ingress API for inbound message authorization"
read_when:
  - Building or migrating a messaging channel plugin
  - Changing DM or group allowlists, route gates, command auth, event auth, or mention activation
  - Reviewing channel ingress redaction or SDK compatibility boundaries
title: "Channel ingress API"
sidebarTitle: "Channel Ingress"
---

# Channel ingress API

Channel ingress is the experimental access-control boundary for inbound channel
events. Use `openclaw/plugin-sdk/channel-ingress-runtime` for receive paths.
The older `openclaw/plugin-sdk/channel-ingress` subpath stays exported as a
deprecated compatibility facade for third-party plugins.

Plugins own platform facts and side effects. Core owns generic policy: DM/group
allowlists, pairing-store DM entries, route gates, command gates, event auth,
mention activation, redacted diagnostics, and admission.

## Runtime Resolver

```ts
import {
  defineStableChannelIngressIdentity,
  resolveChannelMessageIngress,
} from "openclaw/plugin-sdk/channel-ingress-runtime";

const identity = defineStableChannelIngressIdentity({
  key: "platform-user-id",
  normalize: normalizePlatformUserId,
  sensitivity: "pii",
});

const result = await resolveChannelMessageIngress({
  channelId: "my-channel",
  accountId,
  identity,
  subject: { stableId: platformUserId },
  conversation: { kind: isGroup ? "group" : "direct", id: conversationId },
  event: { kind: "message", authMode: "inbound", mayPair: !isGroup },
  policy: {
    dmPolicy: config.dmPolicy,
    groupPolicy: config.groupPolicy,
    groupAllowFromFallbackToAllowFrom: true,
  },
  allowFrom: config.allowFrom,
  groupAllowFrom: config.groupAllowFrom,
  accessGroups: cfg.accessGroups,
  route,
  readStoreAllowFrom,
  command: hasControlCommand ? { allowTextCommands: true, hasControlCommand } : undefined,
});
```

Do not precompute effective allowlists, command owners, or command groups. The
resolver derives them from raw allowlists, store callbacks, route descriptors,
access groups, policy, and conversation kind.

`allowFrom` is the direct-message allowlist. For group conversations, pass
explicit non-DM targets when the channel has them:

- `groupAllowFrom` controls normal group sender authorization.
- `command.commandGroupAllowFrom` controls group command senders.
- `command.groupOwnerAllowFrom` controls group command owners.

`groupAllowFromFallbackToAllowFrom` controls only the shared normal group
sender fallback. `command.commandGroupAllowFromFallbackToAllowFrom` is a
separate command-group override; when omitted, it inherits the normal group
fallback flag. `command.groupOwnerAllowFromFallbackToAllowFrom` controls the
legacy group command-owner fallback and defaults to enabled for compatibility.

When a channel disables one of these fallbacks, update the runtime resolver
input and the doctor capability metadata in the same channel PR. Runtime config
loading does not perform this repair; `openclaw doctor --fix` is the only
preservation-copy path.

Use these runtime flags before declaring the matching manifest metadata:

| Fallback family               | Runtime input to set                                      | Required explicit input                                                                                              |
| ----------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Normal group sender fallback  | `policy.groupAllowFromFallbackToAllowFrom: false`         | `groupAllowFrom` or a route sender allowlist that replaces the legacy fallback.                                      |
| Group command-sender fallback | `command.commandGroupAllowFromFallbackToAllowFrom: false` | `command.commandGroupAllowFrom`, unless command authorization is intentionally covered by explicit `groupAllowFrom`. |
| Group command-owner fallback  | `command.groupOwnerAllowFromFallbackToAllowFrom: false`   | `command.groupOwnerAllowFrom`, or an intentional no-owner mode such as the legacy `"none"` sentinel.                 |

Provider-wide command fallback and elevated fallback are not ingress resolver
inputs. Those paths read prepared channel capability metadata, so the channel PR
must ensure the command or elevated authorization path already has an explicit
target before declaring the fallback disabled.

After the runtime consumes the explicit target, set the corresponding
`package.json#openclaw.channel.doctorCapabilities` fields described in
[Plugin manifest](/plugins/manifest#disable-fallback-in-a-channel-pr). Doctor
infers the copy target from the disabled fallback flag, so channel PRs should
only set the fallback metadata after the target config key is accepted by that
channel schema and read by that channel runtime.

## Result

Bundled plugins should consume modern projections directly:

- `ingress`: ordered gate decision and admission
- `senderAccess`: sender/conversation authorization only
- `routeAccess`: route and route-sender projection
- `commandAccess`: command authorization; false when no command gate ran
- `activationAccess`: mention/activation result

Event authorization remains available on the ordered `ingress.graph` and the
decisive `ingress.reasonCode`; no separate event projection is emitted.

Deprecated third-party SDK helpers may rebuild older shapes internally. New
bundled receive paths should not translate modern results back into local DTOs.

## Access Groups

`accessGroup:<name>` entries stay redacted. Core resolves static
`message.senders` groups itself and calls `resolveAccessGroupMembership` only
for dynamic groups that require a platform lookup. Missing, unsupported, and
failed groups fail closed.

## Event Modes

| `authMode`       | Meaning                                          |
| ---------------- | ------------------------------------------------ |
| `inbound`        | normal inbound sender gates                      |
| `command`        | command gates for callbacks or scoped buttons    |
| `origin-subject` | actor must match the original message subject    |
| `route-only`     | route gates only for route-scoped trusted events |
| `none`           | plugin-owned internal events bypass shared auth  |

Use `mayPair: false` for reactions, buttons, callbacks, and native commands.

## Routes And Activation

Use route descriptors for room, topic, guild, thread, or nested route policy:

```ts
route: {
  id: "room",
  allowed: roomAllowed,
  enabled: roomEnabled,
  senderPolicy: "replace",
  senderAllowFrom: roomAllowFrom,
  blockReason: "room_sender_not_allowlisted",
}
```

Use `channelIngressRoutes(...)` when a plugin has several optional route
descriptors; it filters disabled branches while keeping route facts generic and
ordered by each descriptor's `precedence`.

Mention gating is an activation gate. A mention miss returns
`admission: "skip"` so the turn kernel does not process an observe-only turn.
Most channels should leave activation after sender and command gates. Public
chat surfaces that must quiet non-mentioned traffic before sender allowlist
noise can opt into `activation.order: "before-sender"` when text-command
bypass is disabled. Channels with implicit activation, such as replies in bot
threads, can pass `activation.allowedImplicitMentionKinds`; the projected
`activationAccess.shouldBypassMention` then reports when command or implicit
activation bypassed an explicit mention.

## Redaction

Raw sender values and raw allowlist entries are resolver input only. They must
not appear in resolved state, decisions, diagnostics, snapshots, or
compatibility facts. Use opaque subject ids, entry ids, route ids, and
diagnostic ids.

## Verification

```bash
pnpm test src/channels/message-access/message-access.test.ts src/plugin-sdk/channel-ingress-runtime.test.ts
pnpm plugin-sdk:api:check
```
