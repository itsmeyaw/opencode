import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillPermission } from "@opencode-ai/core/permission/skill"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"
import { SessionNotFoundError } from "@opencode-ai/protocol/errors"

export const SkillHandler = HttpApiBuilder.group(Api, "server.skill", (handlers) =>
  handlers
    .handle("skill.list", () => response(SkillV2.Service.use((skill) => skill.list())))
    .handle(
      "skill.permission.list",
      Effect.fn(function* (ctx) {
        const skills = yield* SkillV2.Service
        const permissions = yield* SkillPermission.Service
        return yield* response(
          permissions
            .list({ agent: ctx.query.agent, sessionID: ctx.query.sessionID, skills: yield* skills.list() })
            .pipe(
              Effect.mapError(
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
            ),
        )
      }),
    )
    .handle(
      "skill.permission.set",
      Effect.fn(function* (ctx) {
        const permissions = yield* SkillPermission.Service
        return yield* response(permissions.set(ctx.payload))
      }),
    ),
)
