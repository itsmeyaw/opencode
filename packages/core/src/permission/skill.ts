export * as SkillPermission from "./skill"

import { Context, Effect, Layer } from "effect"
import { Permission } from "@opencode-ai/schema/permission"
import { Skill } from "@opencode-ai/schema/skill"
import { AgentV2 } from "../agent"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { Location } from "../location"
import { PermissionSaved } from "./saved"
import { SessionV2 } from "../session"
import { SessionStore } from "../session/store"
import { evaluate, missingAgentPermissions } from "./evaluate"

export interface Resolution {
  readonly agent: AgentV2.ID
  readonly states: ReadonlyArray<Skill.PermissionState>
  readonly rules: Permission.Ruleset
}

export interface Interface {
  readonly list: (input: {
    readonly agent: AgentV2.ID
    readonly sessionID?: SessionV2.ID
    readonly skills: ReadonlyArray<Skill.Info>
  }) => Effect.Effect<ReadonlyArray<Skill.PermissionInfo>, SessionV2.NotFoundError>
  readonly set: (input: {
    readonly agent: AgentV2.ID
    readonly name: string
    readonly effect: Permission.Effect
  }) => Effect.Effect<Skill.PermissionState>
  readonly resolve: (input: {
    readonly agent?: AgentV2.ID
    readonly sessionID?: SessionV2.ID
    readonly names: ReadonlyArray<string>
  }) => Effect.Effect<Resolution, SessionV2.NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SkillPermission") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    const events = yield* EventV2.Service
    const location = yield* Location.Service
    const saved = yield* PermissionSaved.Service
    const sessions = yield* SessionStore.Service
    const overrides = new Map<AgentV2.ID, Map<string, Permission.Effect>>()

    const resolve = Effect.fn("SkillPermission.resolve")(function* (input: {
      readonly agent?: AgentV2.ID
      readonly sessionID?: SessionV2.ID
      readonly names: ReadonlyArray<string>
    }) {
      const session = input.sessionID ? yield* sessions.get(input.sessionID) : undefined
      if (
        input.sessionID &&
        (!session ||
          session.location.directory !== location.directory ||
          session.location.workspaceID !== location.workspaceID)
      )
        return yield* new SessionV2.NotFoundError({ sessionID: input.sessionID })
      const agent = yield* agents.select(input.agent ?? session?.agent)
      const configured = [
        ...(agent.info?.permissions ?? missingAgentPermissions),
        ...(input.sessionID ? yield* sessions.permissions(input.sessionID) : []),
      ]
      const remembered = (yield* saved.list({ projectID: location.project.id })).map(
        (item): Permission.Rule => ({ action: item.action, resource: item.resource, effect: "allow" }),
      )
      const states = input.names.map(
        (name): Skill.PermissionState => ({
          name,
          effect:
            overrides.get(agent.id)?.get(name) ??
            (evaluate("skill", name, configured).effect === "deny"
              ? "deny"
              : evaluate("skill", name, configured, remembered).effect),
        }),
      )
      return {
        agent: agent.id,
        states,
        rules: [
          ...configured,
          ...remembered,
          ...states.flatMap((state) =>
            overrides.get(agent.id)?.has(state.name)
              ? [{ action: "skill", resource: state.name, effect: state.effect }]
              : [],
          ),
        ],
      }
    })

    return Service.of({
      list: Effect.fn("SkillPermission.list")(function* (input) {
        const result = yield* resolve({
          agent: input.agent,
          sessionID: input.sessionID,
          names: input.skills.map((skill) => skill.name),
        })
        const effects = new Map(result.states.map((state) => [state.name, state.effect]))
        return input.skills.map((skill) => ({ ...skill, effect: effects.get(skill.name) ?? "ask" }))
      }),
      set: Effect.fn("SkillPermission.set")(function* (input) {
        const current = overrides.get(input.agent) ?? new Map<string, Permission.Effect>()
        current.set(input.name, input.effect)
        overrides.set(input.agent, current)
        const state = { name: input.name, effect: input.effect }
        yield* events.publish(Skill.Event.PermissionUpdated, { agent: input.agent, ...state })
        return state
      }),
      resolve,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [AgentV2.node, EventV2.node, Location.node, PermissionSaved.node, SessionStore.node],
})
