import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Effect, Layer } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { WorkspaceRouteContext } from "./workspace-routing"

export class InstanceContextMiddleware extends HttpApiMiddleware.Service<
  InstanceContextMiddleware,
  {
    requires: WorkspaceRouteContext
  }
>()("@opencode/ExperimentalHttpApiInstanceContext") {}

function decode(input: string): string {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

function provideInstanceContext<E>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E>,
  store: InstanceStore.Interface,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E,
  WorkspaceRouteContext | HttpServerRequest.HttpServerRequest
> {
  return Effect.gen(function* () {
    const route = yield* WorkspaceRouteContext
    const request = yield* HttpServerRequest.HttpServerRequest
    const ctx = yield* store.load({ directory: decode(route.directory) })
    const workspaceID = request.headers["x-opencode-workspace"]
    return yield* effect.pipe(
      Effect.provideService(InstanceRef, ctx),
      Effect.provideService(
        WorkspaceRef,
        route.workspaceID ?? (workspaceID ? WorkspaceV2.ID.make(workspaceID) : undefined),
      ),
    )
  })
}

export const instanceContextLayer = Layer.effect(
  InstanceContextMiddleware,
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    return InstanceContextMiddleware.of((effect) => provideInstanceContext(effect, store))
  }),
)
