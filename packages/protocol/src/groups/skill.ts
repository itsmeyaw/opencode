import { Agent } from "@opencode-ai/schema/agent"
import { Skill } from "@opencode-ai/schema/skill"
import { Location } from "@opencode-ai/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"
import { Session } from "@opencode-ai/schema/session"
import { SessionNotFoundError } from "../errors"

export const SkillGroup = HttpApiGroup.make("server.skill")
  .add(
    HttpApiEndpoint.get("skill.list", "/api/skill", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Skill.Info)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.skill.list",
          summary: "List skills",
          description: "Retrieve currently registered skills.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("skill.permission.list", "/api/skill/permission", {
      query: Schema.Struct({ ...LocationQuery.fields, agent: Agent.ID, sessionID: Session.ID.pipe(Schema.optional) }),
      success: Location.response(Schema.Array(Skill.PermissionInfo)),
      error: SessionNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.skill.permission.list",
          summary: "List skill permissions",
          description: "Retrieve discovered skills and their effective permission for an agent.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.put("skill.permission.set", "/api/skill/permission", {
      query: LocationQuery,
      payload: Schema.Struct({
        agent: Agent.ID,
        name: Schema.String,
        effect: Skill.PermissionState.fields.effect,
      }),
      success: Location.response(Skill.PermissionState),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.skill.permission.set",
          summary: "Set skill permission",
          description: "Set an exact runtime skill permission override for an agent.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "skills",
      description: "Experimental skill routes.",
    }),
  )
