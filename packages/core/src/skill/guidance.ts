export * as SkillGuidance from "./guidance"

import { makeLocationNode } from "../effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { PermissionV2 } from "../permission"
import { SkillPermission } from "../permission/skill"
import { SkillV2 } from "../skill"
import { SessionV2 } from "../session"
import { SystemContext } from "../system-context/index"

const Summary = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
})
type Summary = typeof Summary.Type

const render = (skills: ReadonlyArray<Summary>) =>
  [
    "Skills provide specialized instructions and workflows for specific tasks.",
    "Use the skill tool to load a skill when a task matches its description.",
    ...(skills.length === 0
      ? ["No skills are currently available."]
      : [
          "<available_skills>",
          ...skills.flatMap((skill) => [
            "  <skill>",
            `    <name>${skill.name}</name>`,
            `    <description>${skill.description}</description>`,
            "  </skill>",
          ]),
          "</available_skills>",
        ]),
  ].join("\n")

export interface Interface {
  readonly load: (agent: AgentV2.Selection, sessionID?: SessionV2.ID) => Effect.Effect<SystemContext.SystemContext>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SkillGuidance") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skills = yield* SkillV2.Service
    const permissions = yield* SkillPermission.Service

    return Service.of({
      load: Effect.fn("SkillGuidance.load")(function* (selection, sessionID?: SessionV2.ID) {
        const agent = selection.info
        if (!agent) return SystemContext.empty
        const discovered = yield* skills.list()
        const resolution = yield* permissions.resolve({
          agent: agent.id,
          sessionID,
          names: discovered.map((skill) => skill.name),
        }).pipe(Effect.orDie)
        const effects = new Map(resolution.states.map((state) => [state.name, state.effect]))
        const permitted = discovered.filter(
          (skill) => (effects.get(skill.name) ?? PermissionV2.evaluate("skill", skill.name, agent.permissions).effect) !== "deny",
        )
        if (permitted.length === 0 && PermissionV2.evaluate("skill", "*", agent.permissions).effect === "deny")
          return SystemContext.empty
        const available = permitted
          .flatMap((skill) =>
            skill.description === undefined ? [] : [{ name: skill.name, description: skill.description }],
          )
          .toSorted((a, b) => a.name.localeCompare(b.name))
        return SystemContext.make({
          key: SystemContext.Key.make("core/skill-guidance"),
          codec: Schema.toCodecJson(Schema.Array(Summary)),
          load: Effect.succeed(available),
          baseline: render,
          update: (_previous, current) =>
            [
              "The available skills have changed. This list supersedes the previous available skills list.",
              render(current),
            ].join("\n"),
          removed: () => "Skill guidance is no longer available. Do not use any previously listed skill.",
        })
      }),
    })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [SkillV2.node, SkillPermission.node] })
