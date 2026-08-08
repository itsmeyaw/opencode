import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Effect, Option, Schema } from "effect"

let root = ""
let database = Flag.OPENCODE_DB

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "opencode-embedded-"))
  Flag.OPENCODE_DB = join(root, "opencode.sqlite")
})

afterAll(async () => {
  Flag.OPENCODE_DB = database
  await rm(root, { recursive: true, force: true })
})

test.serial("embedded client uses the real router and handlers", async () => {
  const directory = join(root, "router")
  await mkdir(directory)
  const { AbsolutePath, Agent, Location, Model, OpenCode, Prompt, Provider, Session, Tool } = await import("../src")
  const sessionID = Session.ID.make(`ses_embedded_${crypto.randomUUID()}`)
  const model = Model.Ref.make({ id: Model.ID.make("embedded"), providerID: Provider.ID.make("test") })

  try {
    const program = Effect.gen(function* () {
      const opencode = yield* OpenCode.create()
      const events: Array<{ payload?: { type?: string; properties?: { messageID?: string; sessionID?: string } } }> = []
      yield* Effect.acquireRelease(
        Effect.promise(() => opencode.transport.events.subscribe((event) => events.push(event as (typeof events)[number]))),
        (unsubscribe) => Effect.sync(unsubscribe),
      )
      yield* Effect.promise(async () => {
        const start = Date.now()
        while (!events.some((event) => event.payload?.type === "server.connected")) {
          if (Date.now() - start > 2_000) throw new Error("embedded event transport did not connect")
          await Bun.sleep(10)
        }
      })
      yield* opencode.tools.register({
        embedded_tool: Tool.make({
          description: "Embedded test tool",
          input: Schema.Struct({}),
          output: Schema.Struct({ ok: Schema.Boolean }),
          execute: () => Effect.succeed({ ok: true }),
        }),
      })

      const created = yield* opencode.sessions.create({
        id: sessionID,
        agent: Agent.ID.make("build"),
        location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      })
      yield* opencode.sessions.switchModel({ sessionID, model })
      const selected = yield* opencode.sessions.get({ sessionID })
      const page = yield* opencode.sessions.list({ directory: AbsolutePath.make(directory) })
      const active = yield* opencode.sessions.active()
      const admitted = yield* opencode.sessions.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Do not run" }),
        resume: false,
      })
      const context = yield* opencode.sessions.context({ sessionID })
      const modelMessage = Option.fromNullishOr(context.find((message) => message.type === "model-switched")).pipe(
        Option.getOrThrow,
      )
      const message = yield* opencode.sessions.message({ sessionID, messageID: modelMessage.id })
      yield* opencode.sessions.interrupt({ sessionID })
      const other = yield* opencode.sessions.create({
        location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      })
      const missingSessionID = Session.ID.make(`ses_missing_${crypto.randomUUID()}`)
      const missing = yield* Effect.all(
        [
          opencode.sessions.interrupt({ sessionID: missingSessionID }).pipe(Effect.flip),
          opencode.sessions.message({ sessionID: missingSessionID, messageID: modelMessage.id }).pipe(Effect.flip),
        ],
        { concurrency: "unbounded" },
      )
      const missingMessage = yield* Effect.flip(
        opencode.sessions.message({
          sessionID: other.id,
          messageID: modelMessage.id,
        }),
      )

      expect(created.id).toBe(sessionID)
      expect(selected.model?.id).toBe(model.id)
      expect(selected.model?.providerID).toBe(model.providerID)
      expect(page.data.some((session) => session.id === sessionID)).toBe(true)
      expect(active).toEqual({})
      expect(admitted.sessionID).toBe(sessionID)
      expect(context.some((message) => message.type === "model-switched")).toBe(true)
      expect(events.find((event) => event.payload?.type === "session.next.model.switched")?.payload?.properties?.sessionID).toBe(sessionID)
      expect(message).toEqual(modelMessage)
      expect(missing.map((error) => error._tag)).toEqual([
        "SessionNotFoundError",
        "SessionNotFoundError",
      ])
      expect(missingMessage._tag).toBe("MessageNotFoundError")
    })
    await Effect.runPromise(Effect.scoped(program))
  } finally {}
})

test.serial("Location-owned runner events reach the ready global client", async () => {
  const directory = join(root, "events")
  await mkdir(directory)
  const { AbsolutePath, Location, OpenCode, Prompt, Session } = await import("../src")
  const sessionID = Session.ID.make(`ses_embedded_${crypto.randomUUID()}`)

  try {
    const program = Effect.gen(function* () {
      const opencode = yield* OpenCode.create()
      const events: Array<{ payload?: { type?: string; properties?: { sessionID?: string } } }> = []
      yield* Effect.acquireRelease(
        Effect.promise(() => opencode.transport.events.subscribe((event) => events.push(event as (typeof events)[number]))),
        (unsubscribe) => Effect.sync(unsubscribe),
      )
      yield* waitForEvent(events, "server.connected")
      yield* opencode.sessions.create({
        id: sessionID,
        location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      })
      yield* waitForEvent(events, "session.created")
      const admitted = yield* opencode.sessions.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Observe this input" }),
        resume: false,
      })

      expect(events.find((event) => event.payload?.type === "session.created")?.payload?.properties?.sessionID).toBe(
        sessionID,
      )
      expect(admitted.sessionID).toBe(sessionID)
    })
    await Effect.runPromise(Effect.scoped(program))
  } finally {}
}, 10_000)

test.serial("independent embedded hosts do not share live notifications", async () => {
  const directory = join(root, "hosts")
  await mkdir(directory)
  const { AbsolutePath, Agent, Location, OpenCode, Session } = await import("../src")
  const sessionID = Session.ID.make(`ses_embedded_${crypto.randomUUID()}`)

  try {
    const program = Effect.gen(function* () {
      const first = yield* OpenCode.create()
      const second = yield* OpenCode.create()
      const firstEvents: Array<{ payload?: { type?: string; properties?: { sessionID?: string } } }> = []
      const secondEvents: Array<{ payload?: { type?: string; properties?: { sessionID?: string } } }> = []
      yield* Effect.acquireRelease(
        Effect.promise(() => first.transport.events.subscribe((event) => firstEvents.push(event as (typeof firstEvents)[number]))),
        (unsubscribe) => Effect.sync(unsubscribe),
      )
      yield* Effect.acquireRelease(
        Effect.promise(() => second.transport.events.subscribe((event) => secondEvents.push(event as (typeof secondEvents)[number]))),
        (unsubscribe) => Effect.sync(unsubscribe),
      )
      yield* waitForEvent(firstEvents, "server.connected")
      yield* waitForEvent(secondEvents, "server.connected")
      yield* first.sessions.create({
        id: sessionID,
        location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      })
      yield* first.sessions.switchAgent({ sessionID, agent: Agent.ID.make("plan") })

      yield* waitForEvent(firstEvents, "session.next.agent.switched")
      yield* Effect.promise(() => Bun.sleep(100))
      expect(secondEvents.some((event) => event.payload?.type === "session.next.agent.switched")).toBe(false)
    })
    await Effect.runPromise(Effect.scoped(program))
  } finally {}
}, 10_000)

function waitForEvent(events: Array<{ payload?: { type?: string } }>, type: string) {
  return Effect.promise(async () => {
    const start = Date.now()
    while (!events.some((event) => event.payload?.type === type)) {
      if (Date.now() - start > 2_000) throw new Error(`embedded event transport did not receive ${type}`)
      await Bun.sleep(10)
    }
  })
}

test.serial("embedded client is available as a Layer service", async () => {
  const directory = join(root, "layer")
  await mkdir(directory)
  const { AbsolutePath, Location, OpenCode, Session } = await import("../src")
  const sessionID = Session.ID.make(`ses_embedded_${crypto.randomUUID()}`)

  try {
    const created = await Effect.runPromise(
      Effect.gen(function* () {
        const opencode = yield* OpenCode.Service
        return yield* opencode.sessions.create({
          id: sessionID,
          location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
        })
      }).pipe(Effect.provide(OpenCode.layer), Effect.scoped),
    )

    expect(created.id).toBe(sessionID)
  } finally {}
})

test.serial("embedded transport adapts generated SDK skill permissions and events", async () => {
  const directory = join(root, "skill")
  await mkdir(directory)
  const { createOpencodeClient } = await import("@opencode-ai/sdk/v2")
  const { OpenCode } = await import("../src")

  try {
    Bun.spawnSync(["git", "init", directory])
    await mkdir(join(directory, ".opencode", "skills", "embedded"), { recursive: true })
    await Bun.write(
      join(directory, "opencode.json"),
      JSON.stringify({ formatter: false, lsp: false, permission: { skill: "deny" } }),
    )
    await Bun.write(
      join(directory, ".opencode", "skills", "embedded", "SKILL.md"),
      "---\nname: embedded-transport\ndescription: Embedded transport skill\n---\n# Embedded",
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const opencode = yield* OpenCode.create()
          const events: Array<{ payload?: { type?: string; properties?: { name?: string; effect?: string } } }> = []
          const connected = Promise.withResolvers<void>()
          const updated = Promise.withResolvers<void>()
          yield* Effect.acquireRelease(
            Effect.promise(() =>
              opencode.transport.events.subscribe((event) => {
                events.push(event as { payload?: { type?: string; properties?: { name?: string; effect?: string } } })
                if ((event as { payload?: { type?: string } }).payload?.type === "server.connected") connected.resolve()
                if ((event as { payload?: { type?: string } }).payload?.type === "skill.permission.updated") updated.resolve()
              }),
            ),
            (unsubscribe) => Effect.sync(unsubscribe),
          )
          yield* Effect.promise(() => connected.promise)
          const sdk = createOpencodeClient({
            baseUrl: "http://opencode.local",
            directory,
            fetch: opencode.transport.fetch,
          })
          const before = yield* Effect.promise(() =>
            sdk.v2.skill.permission.list({ agent: "build" }, { throwOnError: true }),
          )
          expect(before.data.data.find((skill) => skill.name === "embedded-transport")?.effect).toBe("deny")
          yield* Effect.promise(() =>
            sdk.v2.skill.permission.set(
              { agent: "build", name: "embedded-transport", effect: "allow" },
              { throwOnError: true },
            ),
          )
          const after = yield* Effect.promise(() =>
            sdk.v2.skill.permission.list({ agent: "build" }, { throwOnError: true }),
          )
          expect(after.data.data.find((skill) => skill.name === "embedded-transport")?.effect).toBe("allow")
          yield* Effect.promise(() => updated.promise)
          expect(events.find((event) => event.payload?.type === "skill.permission.updated")?.payload?.properties).toMatchObject({
            name: "embedded-transport",
            effect: "allow",
          })
        }),
      ),
    )
  } finally {}
}, 10_000)
