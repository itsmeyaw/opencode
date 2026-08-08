import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { InstanceState } from "@/effect/instance-state"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Deferred, Effect, Layer, Context, ScopedCache } from "effect"
import os from "os"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { AgentV2 } from "@opencode-ai/core/agent"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { SkillPermission } from "@opencode-ai/core/permission/skill"
import { SessionV2 } from "@opencode-ai/core/session"
import { Skill } from "@opencode-ai/schema/skill"
import { EventV2 } from "@opencode-ai/core/event"

export const Event = PermissionV1.Event

type AskInput = PermissionV1.AskInput & { readonly agent?: string }

export interface Interface {
  readonly ask: (input: AskInput) => Effect.Effect<void, PermissionV1.Error>
  readonly reply: (input: PermissionV1.ReplyInput) => Effect.Effect<void, PermissionV1.NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<PermissionV1.Request>>
  readonly resolveSkills: (input: {
    readonly agent: string
    readonly sessionID: string
    readonly names: ReadonlyArray<string>
  }) => Effect.Effect<PermissionV1.Ruleset>
}

interface PendingEntry {
  info: PermissionV1.Request
  agent?: string
  deferred: Deferred.Deferred<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>
}

interface State {
  pending: Map<PermissionV1.ID, PendingEntry>
  approved: PermissionV1.Rule[]
}

export function evaluate(permission: string, pattern: string, ...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern)) ?? {
      action: "ask",
      permission,
      pattern: "*",
    }
  )
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const locations = yield* LocationServiceMap.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        void ctx
        const state = {
          pending: new Map<PermissionV1.ID, PendingEntry>(),
          approved: [],
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    const ask = Effect.fn("Permission.ask")(function* (input: AskInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const { ruleset, agent, ...request } = input
      let needsAsk = false

      for (const pattern of request.patterns) {
        const rule =
          request.permission === "skill"
            ? evaluate(request.permission, pattern, ruleset)
            : evaluate(request.permission, pattern, ruleset, approved)
        yield* Effect.logInfo("evaluated", { permission: request.permission, pattern, action: rule })
        if (rule.action === "deny") {
          return yield* new PermissionV1.DeniedError({
            ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
          })
        }
        if (rule.action === "allow") continue
        needsAsk = true
      }

      if (!needsAsk) return

      const id = request.id ?? PermissionV1.ID.ascending()
      const info: PermissionV1.Request = {
        id,
        sessionID: request.sessionID,
        permission: request.permission,
        patterns: request.patterns,
        metadata: request.metadata,
        always: request.always,
        tool: request.tool,
      }
      yield* Effect.logInfo("asking", { id, permission: info.permission, patterns: info.patterns })

      const deferred = yield* Deferred.make<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>()
      pending.set(id, { info, agent, deferred })
      yield* events.publish(Event.Asked, info)
      return yield* Effect.ensuring(
        Deferred.await(deferred),
        Effect.sync(() => {
          pending.delete(id)
        }),
      )
    })

    const reply = Effect.fn("Permission.reply")(function* (input: PermissionV1.ReplyInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const existing = pending.get(input.requestID)
      if (!existing) return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })

      pending.delete(input.requestID)
      yield* events.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: input.reply,
      })

      if (input.reply === "reject") {
        yield* Deferred.fail(
          existing.deferred,
          input.message
            ? new PermissionV1.CorrectedError({ feedback: input.message })
            : new PermissionV1.RejectedError(),
        )

        for (const [id, item] of pending.entries()) {
          if (item.info.sessionID !== existing.info.sessionID) continue
          pending.delete(id)
          yield* events.publish(Event.Replied, {
            sessionID: item.info.sessionID,
            requestID: item.info.id,
            reply: "reject",
          })
          yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
        }
        return
      }

      yield* Deferred.succeed(existing.deferred, undefined)
      if (input.reply === "once") return

      for (const pattern of existing.info.always) {
        approved.push({
          permission: existing.info.permission,
          pattern,
          action: "allow",
        })
      }

      for (const [id, item] of pending.entries()) {
        if (item.info.sessionID !== existing.info.sessionID) continue
        const ok = item.info.patterns.every(
          (pattern) => evaluate(item.info.permission, pattern, approved).action === "allow",
        )
        if (!ok) continue
        pending.delete(id)
        yield* events.publish(Event.Replied, {
          sessionID: item.info.sessionID,
          requestID: item.info.id,
          reply: "always",
        })
        yield* Deferred.succeed(item.deferred, undefined)
      }
    })

    const list = Effect.fn("Permission.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (item) => item.info)
    })

    const resolveSkills = Effect.fn("Permission.resolveSkills")(function* (input: {
      readonly agent: string
      readonly sessionID: string
      readonly names: ReadonlyArray<string>
    }) {
      const location = yield* InstanceState.location
      const approved = (yield* InstanceState.get(state)).approved
      const result = yield* Effect.gen(function* () {
        const permissions = yield* SkillPermission.Service
        return yield* permissions.resolve({
          agent: AgentV2.ID.make(input.agent),
          sessionID: SessionV2.ID.make(input.sessionID),
          names: input.names,
          approvals: approved
            .filter((rule) => rule.permission === "skill")
            .map((rule) => ({ action: rule.permission, resource: rule.pattern, effect: "allow" })),
        })
      }).pipe(Effect.provide(locations.get(location)), Effect.orDie)
      return result.states.map(
        (item): PermissionV1.Rule => ({ permission: "skill", pattern: item.name, action: item.effect }),
      )
    })

    const unsubscribe = yield* events.listen((event) =>
      Effect.gen(function* () {
        if (event.type !== Skill.Event.PermissionUpdated.type) return
        const data = event.data as EventV2.Data<typeof Skill.Event.PermissionUpdated>
        if (data.effect === "ask" || !event.location) return
        if (!(yield* ScopedCache.has(state.cache, event.location.directory))) return
        const pending = (yield* ScopedCache.get(state.cache, event.location.directory)).pending
        for (const [id, item] of pending) {
          if (item.info.permission !== "skill" || item.agent !== data.agent) continue
          if (!item.info.patterns.every((pattern) => pattern === data.name)) continue
          pending.delete(id)
          const reply = data.effect === "allow" ? "always" : "reject"
          yield* events.publish(
            Event.Replied,
            {
              sessionID: item.info.sessionID,
              requestID: item.info.id,
              reply,
            },
            { location: event.location },
          )
          if (data.effect === "allow") {
            yield* Deferred.succeed(item.deferred, undefined)
            continue
          }
          yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
        }
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)

    return Service.of({ ask, reply, list, resolveSkills })
  }),
)

function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

export function fromConfig(permission: ConfigPermissionV1.Info) {
  const ruleset: PermissionV1.Rule[] = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    ruleset.push(
      ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
    )
  }
  return ruleset
}

export function merge(...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule[] {
  return rulesets.flat()
}

export function disabled(tools: string[], ruleset: PermissionV1.Ruleset): Set<string> {
  const edits = ["edit", "write", "apply_patch"]
  const reads = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]
  return new Set(
    tools.filter((tool) => {
      const permission = edits.includes(tool) ? "edit" : reads.includes(tool) ? "read" : tool
      const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
      return rule?.pattern === "*" && rule.action === "deny"
    }),
  )
}

export function visibleTools<T>(tools: Record<string, T>, ruleset: PermissionV1.Ruleset): Record<string, T> {
  const hidden = disabled(Object.keys(tools), ruleset)
  return Object.fromEntries(Object.entries(tools).filter(([name]) => !hidden.has(name)))
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [EventV2Bridge.node, LocationServiceMap.node],
})

export * as Permission from "."
