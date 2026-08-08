import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import path from "path"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Server } from "../../src/server/server"
import { Context, Effect, Fiber, Layer } from "effect"
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import Http from "node:http"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

const it = testEffect(TestLLMServer.layer)

setDefaultTimeout(30_000)

const environment = [
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_TEST_HOME",
  "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS",
  "OPENCODE_DISABLE_EXTERNAL_SKILLS",
] as const

const original = Object.fromEntries(environment.map((key) => [key, process.env[key]]))

function environmentTest(name: string, fn: () => Promise<void>) {
  return test(name, async () => {
    try {
      await fn()
    } finally {
      for (const key of environment) {
        const value = original[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

function writeSkill(directory: string, source: string, name: string, description: string) {
  return Bun.write(
    path.join(directory, source, "SKILL.md"),
    `---
name: ${name}
description: ${description}
---
# ${name}`,
  )
}

function toolNames(input: Record<string, unknown> | undefined) {
  if (!Array.isArray(input?.tools)) return []
  return input.tools.flatMap((tool) => {
    if (!tool || typeof tool !== "object" || !("function" in tool)) return []
    const fn = tool.function
    if (!fn || typeof fn !== "object" || !("name" in fn) || typeof fn.name !== "string") return []
    return [fn.name]
  })
}

function enableExternalSources() {
  process.env.OPENCODE_DISABLE_CLAUDE_CODE = "false"
  process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = "false"
  process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "false"
}

describe.serial("skill HttpApi", () => {
  environmentTest("matches the user-visible inventory for OpenCode, path, URL, built-in, and duplicate sources", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            NodeHttpServer.layer(Http.createServer, { host: "127.0.0.1", port: 0 }).pipe(Layer.provide(NodeServices.layer)),
          )
          const catalog = Context.get(context, HttpServer.HttpServer)
          yield* catalog.serve(
            HttpServerRequest.HttpServerRequest.use((request) => {
              const pathname = new URL(request.url, "http://localhost").pathname
              if (pathname === "/catalog/index.json")
                return HttpServerResponse.json({
                  skills: [
                    { name: "ticket-2-url", version: "1", files: ["SKILL.md"] },
                    { name: "customize-opencode", version: "1", files: ["SKILL.md"] },
                  ],
                })
              if (pathname === "/catalog/ticket-2-url/SKILL.md")
                return Effect.succeed(
                  HttpServerResponse.text(`---\nname: ticket-2-url\ndescription: URL skill\n---\n# URL skill`),
                )
              if (pathname === "/catalog/customize-opencode/SKILL.md")
                return Effect.succeed(
                  HttpServerResponse.text(`---\nname: customize-opencode\ndescription: URL duplicate\n---\n# URL duplicate`),
                )
              return Effect.succeed(HttpServerResponse.text("Not Found", { status: 404 }))
            }),
          )
          const address = HttpServer.formatAddress(catalog.address)
          yield* Effect.promise(async () => {
            await using home = await tmpdir()
            await using project = await tmpdir({ git: true })
            process.env.OPENCODE_TEST_HOME = home.path
            process.env.OPENCODE_CONFIG_DIR = path.join(home.path, "config")
            enableExternalSources()
            await Promise.all([
      writeSkill(home.path, ".claude/skills/customize", "customize-opencode", "Global Claude duplicate"),
      writeSkill(home.path, ".agents/skills/customize", "customize-opencode", "Global agent duplicate"),
      writeSkill(process.env.OPENCODE_CONFIG_DIR, "skills/global-opencode", "ticket-2-global", "Global OpenCode skill"),
      writeSkill(project.path, ".opencode/skill/project", "ticket-2-project", "Project OpenCode skill"),
      writeSkill(project.path, ".opencode/skill/customize", "customize-opencode", "Project OpenCode duplicate"),
      writeSkill(project.path, "extra/path", "ticket-2-path", "Configured path skill"),
      writeSkill(project.path, "extra/customize", "customize-opencode", "Configured duplicate"),
      Bun.write(
        path.join(project.path, "opencode.json"),
        JSON.stringify({
          formatter: false,
          lsp: false,
          skills: {
            paths: ["./extra"],
            urls: [`${address}/catalog/`],
          },
        }),
      ),
            ])

            const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
            try {
      const sdk = createOpencodeClient({ baseUrl: listener.url.href, directory: project.path })
      const current = await sdk.v2.skill.list(undefined, { throwOnError: true })
      const repeated = await sdk.v2.skill.list(undefined, { throwOnError: true })
      const legacy = await sdk.app.skills(undefined, { throwOnError: true })

      expect(current.data.data.map((skill) => skill.name)).toEqual(legacy.data.map((skill) => skill.name))
      expect(current.data.data.map((skill) => skill.name)).toEqual([
        "customize-opencode",
        "ticket-2-project",
        "ticket-2-global",
        "ticket-2-path",
        "ticket-2-url",
      ])
      expect(repeated.data.data.map((skill) => skill.name)).toEqual(current.data.data.map((skill) => skill.name))
      expect((await sdk.app.skills(undefined, { throwOnError: true })).data.map((skill) => skill.name)).toEqual(
        current.data.data.map((skill) => skill.name),
      )
      expect(current.data.data.find((skill) => skill.name === "customize-opencode")?.description).toBe("URL duplicate")
            } finally {
              await listener.stop()
            }
          })
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    ),
  )

  environmentTest("matches eligible global and project Claude and agent skill sources", async () => {
    await using home = await tmpdir()
    await using project = await tmpdir({ git: true })
    process.env.OPENCODE_TEST_HOME = home.path
    process.env.OPENCODE_CONFIG_DIR = path.join(home.path, "config")
    enableExternalSources()
    await Promise.all([
      writeSkill(home.path, ".claude/skills/global-claude", "ticket-2-global-claude", "Global Claude skill"),
      writeSkill(home.path, ".agents/skills/global-agent", "ticket-2-global-agent", "Global agent skill"),
      writeSkill(project.path, ".claude/skills/project-claude", "ticket-2-project-claude", "Project Claude skill"),
      writeSkill(project.path, ".agents/skills/project-agent", "ticket-2-project-agent", "Project agent skill"),
      writeSkill(project.path, ".opencode/skills/project", "ticket-2-opencode", "OpenCode skill"),
      Bun.write(path.join(project.path, "opencode.json"), JSON.stringify({ formatter: false, lsp: false })),
    ])

    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      const sdk = createOpencodeClient({ baseUrl: listener.url.href, directory: project.path })
      const current = await sdk.v2.skill.list(undefined, { throwOnError: true })
      const legacy = await sdk.app.skills(undefined, { throwOnError: true })

      expect(current.data.data.map((skill) => skill.name)).toEqual(legacy.data.map((skill) => skill.name))
      expect(current.data.data.map((skill) => skill.name)).toEqual([
        "customize-opencode",
        "ticket-2-global-claude",
        "ticket-2-global-agent",
        "ticket-2-project-claude",
        "ticket-2-project-agent",
        "ticket-2-opencode",
      ])
    } finally {
      await listener.stop()
    }
  })

  environmentTest("preserves direct and broad Claude skill disable flags", async () => {
    for (const flag of ["OPENCODE_DISABLE_CLAUDE_CODE_SKILLS", "OPENCODE_DISABLE_CLAUDE_CODE"] as const) {
      await using home = await tmpdir()
      await using project = await tmpdir({ git: true })
      process.env.OPENCODE_TEST_HOME = home.path
      process.env.OPENCODE_CONFIG_DIR = path.join(home.path, "config")
      enableExternalSources()
      process.env[flag] = "true"
      await Promise.all([
        writeSkill(home.path, ".claude/skills/global-claude", "ticket-2-global-claude", "Global Claude skill"),
        writeSkill(home.path, ".agents/skills/global-agent", "ticket-2-global-agent", "Global agent skill"),
        writeSkill(project.path, ".claude/skills/project-claude", "ticket-2-project-claude", "Project Claude skill"),
        writeSkill(project.path, ".agents/skills/project-agent", "ticket-2-project-agent", "Project agent skill"),
        writeSkill(project.path, ".opencode/skills/project", "ticket-2-opencode", "OpenCode skill"),
        Bun.write(path.join(project.path, "opencode.json"), JSON.stringify({ formatter: false, lsp: false })),
      ])

      const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
      try {
        const sdk = createOpencodeClient({ baseUrl: listener.url.href, directory: project.path })
        const current = await sdk.v2.skill.list(undefined, { throwOnError: true })
        const legacy = await sdk.app.skills(undefined, { throwOnError: true })

        expect(current.data.data.map((skill) => skill.name)).toEqual(legacy.data.map((skill) => skill.name))
        expect(current.data.data.map((skill) => skill.name)).toEqual([
          "customize-opencode",
          "ticket-2-global-agent",
          "ticket-2-project-agent",
          "ticket-2-opencode",
        ])
      } finally {
        await listener.stop()
        delete process.env[flag]
      }
    }
  })

  environmentTest("external disable excludes only automatic Claude and agent sources", async () => {
    await using home = await tmpdir()
    await using project = await tmpdir({ git: true })
    process.env.OPENCODE_TEST_HOME = home.path
    process.env.OPENCODE_CONFIG_DIR = path.join(home.path, "config")
    enableExternalSources()
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true"
    await Promise.all([
      writeSkill(home.path, ".claude/skills/global-claude", "ticket-2-global-claude", "Global Claude skill"),
      writeSkill(home.path, ".agents/skills/global-agent", "ticket-2-global-agent", "Global agent skill"),
      writeSkill(project.path, ".claude/skills/project-claude", "ticket-2-project-claude", "Project Claude skill"),
      writeSkill(project.path, ".agents/skills/project-agent", "ticket-2-project-agent", "Project agent skill"),
      writeSkill(project.path, ".opencode/skills/project", "ticket-2-opencode", "OpenCode skill"),
      writeSkill(project.path, "extra/path", "ticket-2-path", "Configured path skill"),
      Bun.write(
        path.join(project.path, "opencode.json"),
        JSON.stringify({ formatter: false, lsp: false, skills: { paths: ["./extra"] } }),
      ),
    ])

    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      const sdk = createOpencodeClient({ baseUrl: listener.url.href, directory: project.path })
      const current = await sdk.v2.skill.list(undefined, { throwOnError: true })
      const legacy = await sdk.app.skills(undefined, { throwOnError: true })

      expect(current.data.data.map((skill) => skill.name)).toEqual(legacy.data.map((skill) => skill.name))
      expect(current.data.data.map((skill) => skill.name)).toEqual(["customize-opencode", "ticket-2-opencode", "ticket-2-path"])
    } finally {
      await listener.stop()
    }
  })

  test("reads effective skill permissions for the selected agent", async () => {
    await using project = await tmpdir({ git: true })
    await Promise.all([
      writeSkill(project.path, ".opencode/skills/allowed", "ticket-4-allowed", "Allowed skill"),
      writeSkill(project.path, ".opencode/skills/asked", "ticket-4-asked", "Asked skill"),
      writeSkill(project.path, ".opencode/skills/denied", "ticket-4-denied", "Denied skill"),
      Bun.write(
        path.join(project.path, "opencode.json"),
        JSON.stringify({
          formatter: false,
          lsp: false,
          permission: {
            skill: {
              "*": "allow",
              "ticket-4-asked": "ask",
              "ticket-4-denied": "deny",
            },
          },
        }),
      ),
    ])

    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      const sdk = createOpencodeClient({ baseUrl: listener.url.href, directory: project.path })
      const result = await sdk.v2.skill.permission.list({ agent: "build" }, { throwOnError: true })

      expect(
        result.data.data
          .filter((skill) => skill.name.startsWith("ticket-4-"))
          .map((skill) => ({ name: skill.name, effect: skill.effect })),
      ).toEqual([
        { name: "ticket-4-allowed", effect: "allow" },
        { name: "ticket-4-asked", effect: "ask" },
        { name: "ticket-4-denied", effect: "deny" },
      ])
    } finally {
      await listener.stop()
    }
  })

  test("sets exact agent-scoped runtime skill permissions", async () => {
    await using project = await tmpdir({ git: true })
    await Promise.all([
      writeSkill(project.path, ".opencode/skills/literal", "ticket-4-literal*", "Literal wildcard skill"),
      writeSkill(project.path, ".opencode/skills/similar", "ticket-4-literal-one", "Similar skill"),
      Bun.write(
        path.join(project.path, "opencode.json"),
        JSON.stringify({
          formatter: false,
          lsp: false,
          permission: { skill: "deny" },
          agent: {
            reviewer: {
              description: "Reviews changes",
              mode: "primary",
              permission: { skill: "ask" },
            },
          },
        }),
      ),
    ])

    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      const sdk = createOpencodeClient({ baseUrl: listener.url.href, directory: project.path })
      const config = await Bun.file(path.join(project.path, "opencode.json")).text()
      const name = "ticket-4-literal*"
      const set = (effect: "allow" | "deny" | "ask") =>
        sdk.v2.skill.permission.set({ agent: "build", name, effect }, { throwOnError: true })

      expect((await set("allow")).data.data).toMatchObject({ name, effect: "allow" })
      const build = await sdk.v2.skill.permission.list({ agent: "build" }, { throwOnError: true })
      expect(build.data.data.find((skill) => skill.name === name)?.effect).toBe("allow")
      expect(build.data.data.find((skill) => skill.name === "ticket-4-literal-one")?.effect).toBe("deny")
      const reviewer = await sdk.v2.skill.permission.list({ agent: "reviewer" }, { throwOnError: true })
      expect(reviewer.data.data.find((skill) => skill.name === name)?.effect).toBe("ask")
      expect((await set("deny")).data.data).toMatchObject({ name, effect: "deny" })
      expect((await set("ask")).data.data).toMatchObject({ name, effect: "ask" })
      expect(await Bun.file(path.join(project.path, "opencode.json")).text()).toBe(config)
    } finally {
      await listener.stop()
    }
  })

  test("isolates runtime overrides by Location and clears them when Location services are disposed", async () => {
    await using first = await tmpdir({ git: true })
    await using second = await tmpdir({ git: true })
    await Promise.all(
      [first.path, second.path].flatMap((directory) => [
        writeSkill(directory, ".opencode/skills/isolation", "ticket-4-isolation", "Isolated skill"),
        Bun.write(
          path.join(directory, "opencode.json"),
          JSON.stringify({ formatter: false, lsp: false, permission: { skill: "deny" } }),
        ),
      ]),
    )

    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      const firstSdk = createOpencodeClient({ baseUrl: listener.url.href, directory: first.path })
      const secondSdk = createOpencodeClient({ baseUrl: listener.url.href, directory: second.path })
      await firstSdk.v2.skill.permission.set(
        { agent: "build", name: "ticket-4-isolation", effect: "allow" },
        { throwOnError: true },
      )

      const read = async (sdk: ReturnType<typeof createOpencodeClient>) =>
        (await sdk.v2.skill.permission.list({ agent: "build" }, { throwOnError: true })).data.data.find(
          (skill) => skill.name === "ticket-4-isolation",
        )?.effect

      expect(await read(firstSdk)).toBe("allow")
      expect(await read(secondSdk)).toBe("deny")
      const session = await firstSdk.v2.session.create(
        { agent: "build", location: { directory: first.path } },
        { throwOnError: true },
      )
      const failure = Promise.resolve(
        secondSdk.v2.skill.permission.list({ agent: "build", sessionID: session.data.data.id }, { throwOnError: true }),
      ).then(
        () => undefined,
        (error) => error,
      )
      expect(await failure).toBeInstanceOf(Error)
      await firstSdk.instance.dispose(undefined, { throwOnError: true })
      expect(await read(firstSdk)).toBe("deny")
    } finally {
      await listener.stop()
    }
  })

  test("publishes a Location-qualified event for a successful runtime mutation", async () => {
    await using project = await tmpdir({ git: true })
    await Promise.all([
      writeSkill(project.path, ".opencode/skills/event", "ticket-4-event", "Event skill"),
      Bun.write(path.join(project.path, "opencode.json"), JSON.stringify({ formatter: false, lsp: false })),
    ])

    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    const controller = new AbortController()
    try {
      const sdk = createOpencodeClient({ baseUrl: listener.url.href, directory: project.path })
      const events = await sdk.v2.event.subscribe({ signal: controller.signal })
      const iterator = events.stream[Symbol.asyncIterator]()
      expect((await iterator.next()).value?.type).toBe("server.connected")

      await sdk.v2.skill.permission.set(
        { agent: "build", name: "ticket-4-event", effect: "deny" },
        { throwOnError: true },
      )
      const next = await Promise.race([
        (async () => {
          while (true) {
            const item = await iterator.next()
            if (item.done) throw new Error("Event stream closed before skill permission event")
            if (item.value.type === "skill.permission.updated") return item
          }
        })(),
        Bun.sleep(2_000).then(() => {
          throw new Error("Timed out waiting for skill permission event")
        }),
      ])

      expect(next.value).toMatchObject({
        type: "skill.permission.updated",
        location: { directory: project.path },
        data: { agent: "build", name: "ticket-4-event", effect: "deny" },
      })
      await iterator.return?.()
    } finally {
      controller.abort()
      await listener.stop()
    }
  })

  test("resolves Session rules, saved approvals, and runtime overrides in precedence order", async () => {
    await using project = await tmpdir({ git: true })
    await Promise.all([
      writeSkill(project.path, ".opencode/skills/session", "ticket-4-session", "Session-controlled skill"),
      writeSkill(project.path, ".opencode/skills/saved", "ticket-4-saved", "Saved skill"),
      Bun.write(
        path.join(project.path, "opencode.json"),
        JSON.stringify({
          formatter: false,
          lsp: false,
          permission: {
            skill: {
              "*": "allow",
              "ticket-4-saved": "ask",
            },
          },
        }),
      ),
    ])

    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      const sdk = createOpencodeClient({ baseUrl: listener.url.href, directory: project.path })
      const created = await sdk.session.create(
        {
          title: "Skill permission precedence",
          permission: [{ permission: "skill", pattern: "ticket-4-session", action: "deny" }],
        },
        { throwOnError: true },
      )
      const sessionID = created.data.id
      const asked = await sdk.v2.session.permission.create(
        {
          sessionID,
          action: "skill",
          resources: ["ticket-4-saved"],
          save: ["ticket-4-saved"],
          agent: "build",
        },
        { throwOnError: true },
      )
      expect(asked.data.data.effect).toBe("ask")
      await sdk.v2.session.permission.reply(
        { sessionID, requestID: asked.data.data.id, reply: "always" },
        { throwOnError: true },
      )

      const before = await sdk.v2.skill.permission.list({ agent: "build", sessionID }, { throwOnError: true })
      expect(before.data.data.find((skill) => skill.name === "ticket-4-session")?.effect).toBe("deny")
      expect(before.data.data.find((skill) => skill.name === "ticket-4-saved")?.effect).toBe("allow")

      await sdk.v2.skill.permission.set(
        { agent: "build", name: "ticket-4-session", effect: "allow" },
        { throwOnError: true },
      )
      await sdk.v2.skill.permission.set(
        { agent: "build", name: "ticket-4-saved", effect: "ask" },
        { throwOnError: true },
      )
      const after = await sdk.v2.skill.permission.list({ agent: "build", sessionID }, { throwOnError: true })
      expect(after.data.data.find((skill) => skill.name === "ticket-4-session")?.effect).toBe("allow")
      expect(after.data.data.find((skill) => skill.name === "ticket-4-saved")?.effect).toBe("ask")

      await sdk.instance.dispose(undefined, { throwOnError: true })
      const reset = await sdk.v2.skill.permission.list({ agent: "build", sessionID }, { throwOnError: true })
      expect(reset.data.data.find((skill) => skill.name === "ticket-4-session")?.effect).toBe("deny")
      expect(reset.data.data.find((skill) => skill.name === "ticket-4-saved")?.effect).toBe("allow")
    } finally {
      await listener.stop()
    }
  })

  test("enforces runtime skill permissions in V2 authorization", async () => {
    await using project = await tmpdir({ git: true })
    await Promise.all([
      writeSkill(project.path, ".opencode/skills/enforced", "ticket-4-enforced", "Enforced skill"),
      Bun.write(
        path.join(project.path, "opencode.json"),
        JSON.stringify({ formatter: false, lsp: false, permission: { skill: "deny" } }),
      ),
    ])

    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      const sdk = createOpencodeClient({ baseUrl: listener.url.href, directory: project.path })
      const session = await sdk.v2.session.create(
        { agent: "build", location: { directory: project.path } },
        { throwOnError: true },
      )
      const sessionID = session.data.data.id

      for (const effect of ["allow", "deny", "ask"] as const) {
        await sdk.v2.skill.permission.set({ agent: "build", name: "ticket-4-enforced", effect }, { throwOnError: true })
        const listed = await sdk.v2.skill.permission.list({ agent: "build", sessionID }, { throwOnError: true })
        expect(listed.data.data.find((skill) => skill.name === "ticket-4-enforced")?.effect).toBe(effect)
        const result = await sdk.v2.session.permission.create(
          { sessionID, action: "skill", resources: ["ticket-4-enforced"], agent: "build" },
          { throwOnError: true },
        )
        expect(result.data.data.effect).toBe(effect)
      }
    } finally {
      await listener.stop()
    }
  })

  it.live(
    "reconciles exact runtime skill guidance across consecutive V2 provider turns",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const project = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir({ git: true })),
          (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
        )
        yield* Effect.promise(() =>
          Promise.all([
            writeSkill(project.path, ".opencode/skills/enforced", "ticket-4-provider", "Provider skill"),
            Bun.write(
              path.join(project.path, "opencode.json"),
              JSON.stringify({
                formatter: false,
                lsp: false,
                permissions: [{ action: "skill", resource: "*", effect: "deny" }],
                providers: {
                  test: {
                    env: [],
                    api: {
                      type: "aisdk",
                      package: "@ai-sdk/openai-compatible",
                      url: llm.url,
                      settings: {},
                    },
                    request: { body: { apiKey: "test-key" } },
                    models: {
                      "test-model": {
                        capabilities: { tools: true, input: ["text"], output: ["text"] },
                        limit: { context: 100_000, output: 10_000 },
                      },
                    },
                  },
                },
              }),
            ),
          ]),
        )
        const listener = yield* Effect.acquireRelease(
          Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 })),
          (server) => Effect.promise(() => server.stop()),
        )
        const sdk = createOpencodeClient({ baseUrl: listener.url.href, directory: project.path })

        const created = yield* Effect.promise(() =>
          sdk.v2.session.create(
            {
              agent: "build",
              model: { id: "test-model", providerID: "test" },
              location: { directory: project.path },
            },
            { throwOnError: true },
          ),
        )
        const sessionID = created.data.data.id
        for (const [index, effect] of (["allow", "ask", "deny"] as const).entries()) {
          yield* Effect.promise(() =>
            sdk.v2.skill.permission.set({ agent: "build", name: "ticket-4-provider", effect }, { throwOnError: true }),
          )
          yield* llm.text(`completed ${effect}`)
          yield* Effect.promise(() =>
            sdk.v2.session.prompt(
              { sessionID, prompt: { text: `test ${effect}` } },
              { throwOnError: true },
            ),
          )
          yield* llm.wait(index + 1).pipe(
            Effect.timeoutOrElse({
              duration: "3 seconds",
              orElse: () =>
                Effect.promise(() =>
                  sdk.v2.session.history({ sessionID }, { throwOnError: true }),
                ).pipe(Effect.flatMap((history) => Effect.die(JSON.stringify(history.data)))),
            }),
          )
        }
        const inputs = yield* llm.inputs
        const first = inputs[0] ?? {}
        const firstMessages = Array.isArray(first.messages) ? first.messages : []
        const third = inputs[2] ?? {}
        const thirdMessages = Array.isArray(third.messages) ? third.messages : []
        expect(JSON.stringify(inputs[0])).toContain("ticket-4-provider")
        expect(JSON.stringify(inputs[1])).toContain("ticket-4-provider")
        expect(toolNames(inputs[0])).toContain("skill")
        expect(toolNames(inputs[1])).toContain("skill")
        expect(toolNames(inputs[2])).not.toContain("skill")
        expect(JSON.stringify(thirdMessages.at(-1))).not.toContain("ticket-4-provider")
        expect(JSON.stringify(thirdMessages.at(-1))).toContain("Skill guidance is no longer available")
        expect(thirdMessages[0]).toEqual(firstMessages[0])
        expect(JSON.stringify(inputs[2]?.messages)).toContain("test allow")
        expect(JSON.stringify(inputs[2]?.messages)).toContain("test ask")
        const context = yield* Effect.promise(() => sdk.v2.session.context({ sessionID }, { throwOnError: true }))
        expect(context.data.data.filter((message) => message.type === "system").map((message) => message.text)).toEqual([
          "Skill guidance is no longer available. Do not use any previously listed skill.",
        ])

        yield* llm.text("completed plan")
        const plan = yield* Effect.promise(() =>
          sdk.v2.session.create(
            {
              agent: "plan",
              model: { id: "test-model", providerID: "test" },
              location: { directory: project.path },
            },
            { throwOnError: true },
          ),
        )
        yield* Effect.promise(() =>
          sdk.v2.session.prompt(
            { sessionID: plan.data.data.id, prompt: { text: "test second agent" } },
            { throwOnError: true },
          ),
        )
        yield* llm.wait(4)
        expect(toolNames((yield* llm.inputs)[3])).not.toContain("skill")

        const idle = yield* Effect.promise(() =>
          sdk.v2.session.create(
            {
              agent: "build",
              model: { id: "test-model", providerID: "test" },
              location: { directory: project.path },
            },
            { throwOnError: true },
          ),
        )
        const calls = yield* llm.calls
        yield* Effect.promise(() =>
          sdk.v2.skill.permission.set({ agent: "build", name: "ticket-4-provider", effect: "allow" }, { throwOnError: true }),
        )
        const idleActive = yield* Effect.promise(() => sdk.v2.session.active({ throwOnError: true }))
        expect(idleActive.data.data).not.toHaveProperty(idle.data.data.id)
        expect(yield* llm.calls).toBe(calls)

        const release = Promise.withResolvers<void>()
        yield* llm.hold("completed in flight", release.promise)
        yield* Effect.promise(() =>
          sdk.v2.session.prompt(
            { sessionID, prompt: { text: "test in flight mutation" } },
            { throwOnError: true },
          ),
        )
        yield* llm.wait(calls + 1)
        yield* Effect.promise(() =>
          sdk.v2.skill.permission.set({ agent: "build", name: "ticket-4-provider", effect: "deny" }, { throwOnError: true }),
        )
        const active = yield* Effect.promise(() => sdk.v2.session.active({ throwOnError: true }))
        expect(active.data.data).toHaveProperty(sessionID)
        expect(yield* llm.calls).toBe(calls + 1)
        release.resolve()
        yield* pollWithTimeout(
          Effect.promise(() => sdk.v2.session.active({ throwOnError: true })).pipe(
            Effect.map((result) => (sessionID in result.data.data ? undefined : true)),
          ),
          "in-flight provider turn did not settle",
        )
      }),
    20_000,
  )

  it.live(
    "reconciles Session policy and runtime skill guidance across consecutive legacy provider turns",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const project = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir({ git: true })),
          (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
        )
        yield* Effect.promise(() =>
          Promise.all([
            writeSkill(project.path, ".opencode/skills/enforced", "ticket-5-provider", "Legacy provider skill"),
            Bun.write(
              path.join(project.path, "opencode.json"),
              JSON.stringify({
                ...testProviderConfig(llm.url),
                permission: { skill: "deny" },
              }),
            ),
          ]),
        )
        const listener = yield* Effect.acquireRelease(
          Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 })),
          (server) => Effect.promise(() => server.stop()),
        )
        const sdk = createOpencodeClient({ baseUrl: listener.url.href, directory: project.path })
        const legacy = yield* Effect.promise(() =>
          sdk.session.create(
            {
              title: "Legacy runtime skill permissions",
              permission: [{ permission: "skill", pattern: "ticket-5-provider", action: "deny" }],
            },
            { throwOnError: true },
          ),
        )
        for (const [index, effect] of (["allow", "ask", "deny"] as const).entries()) {
          yield* Effect.promise(() =>
            sdk.v2.skill.permission.set({ agent: "build", name: "ticket-5-provider", effect }, { throwOnError: true }),
          )

          const authorized = yield* Effect.promise(() =>
            sdk.v2.session.permission.create(
              {
                sessionID: legacy.data.id,
                action: "skill",
                resources: ["ticket-5-provider"],
                agent: "build",
              },
              { throwOnError: true },
            ),
          )
          expect(authorized.data.data.effect).toBe(effect)

          yield* llm.text(`completed legacy ${effect}`)
          yield* Effect.promise(() =>
            sdk.session.prompt(
              {
                sessionID: legacy.data.id,
                agent: "build",
                model: { providerID: "test", modelID: "test-model" },
                parts: [{ type: "text", text: `test legacy ${effect}` }],
              },
              { throwOnError: true },
            ),
          )
          yield* llm.wait(index + 1).pipe(
            Effect.timeoutOrElse({
              duration: "5 seconds",
              orElse: () => Effect.die(`legacy ${effect} turn did not reach the provider`),
            }),
          )

        }
        const inputs = yield* llm.inputs
        expect(JSON.stringify(inputs[0])).toContain("ticket-5-provider")
        expect(JSON.stringify(inputs[1])).toContain("ticket-5-provider")
        expect(JSON.stringify(inputs[2])).not.toContain("ticket-5-provider")
        expect(toolNames(inputs[0])).toContain("skill")
        expect(toolNames(inputs[1])).toContain("skill")
        expect(toolNames(inputs[2])).not.toContain("skill")
        expect(JSON.stringify(inputs[2]?.messages)).toContain("test legacy allow")
        expect(JSON.stringify(inputs[2]?.messages)).toContain("test legacy ask")
      }),
    30_000,
  )

  it.live(
    "keeps an exact runtime ask above a legacy saved approval",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const project = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir({ git: true })),
          (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
        )
        yield* Effect.promise(() =>
          Promise.all([
            writeSkill(project.path, ".opencode/skills/saved", "ticket-5-saved", "Saved legacy skill"),
            Bun.write(
              path.join(project.path, "opencode.json"),
              JSON.stringify({ ...testProviderConfig(llm.url), permission: { skill: "ask" } }),
            ),
          ]),
        )
        const listener = yield* Effect.acquireRelease(
          Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 })),
          (server) => Effect.promise(() => server.stop()),
        )
        const sdk = createOpencodeClient({ baseUrl: listener.url.href, directory: project.path })
        yield* Effect.promise(() =>
          sdk.v2.skill.permission.set(
            { agent: "build", name: "ticket-5-saved", effect: "ask" },
            { throwOnError: true },
          ),
        )

        yield* llm.tool("skill", { name: "ticket-5-saved" })
        yield* llm.text("first completed")
        const first = yield* Effect.promise(() =>
          sdk.session.create({ title: "Save legacy skill approval" }, { throwOnError: true }),
        )
        const firstPrompt = yield* Effect.promise(() =>
          sdk.session.prompt(
            {
              sessionID: first.data.id,
              agent: "build",
              model: { providerID: "test", modelID: "test-model" },
              parts: [{ type: "text", text: "load the saved skill" }],
            },
            { throwOnError: true },
          ),
        ).pipe(Effect.forkScoped)
        const firstRequest = yield* pollWithTimeout(
          Effect.promise(() => sdk.permission.list(undefined, { throwOnError: true })).pipe(
            Effect.map((result) => result.data.find((request) => request.sessionID === first.data.id)),
          ),
          "legacy skill approval did not become pending",
        )
        yield* Effect.promise(() =>
          sdk.permission.reply({ requestID: firstRequest.id, reply: "always" }, { throwOnError: true }),
        )
        yield* Fiber.join(firstPrompt)

        yield* llm.tool("skill", { name: "ticket-5-saved" })
        yield* llm.text("second completed")
        const second = yield* Effect.promise(() =>
          sdk.session.create({ title: "Recheck legacy skill approval" }, { throwOnError: true }),
        )
        const secondPrompt = yield* Effect.promise(() =>
          sdk.session.prompt(
            {
              sessionID: second.data.id,
              agent: "build",
              model: { providerID: "test", modelID: "test-model" },
              parts: [{ type: "text", text: "load the saved skill again" }],
            },
            { throwOnError: true },
          ),
        ).pipe(Effect.forkScoped)
        const secondRequest = yield* pollWithTimeout(
          Effect.promise(() => sdk.permission.list(undefined, { throwOnError: true })).pipe(
            Effect.map((result) => result.data.find((request) => request.sessionID === second.data.id)),
          ),
          "runtime ask was overridden by the legacy saved approval",
        )
        yield* Effect.promise(() =>
          sdk.permission.reply({ requestID: secondRequest.id, reply: "once" }, { throwOnError: true }),
        )
        yield* Fiber.join(secondPrompt)
      }),
    30_000,
  )

  it.live(
    "releases a pending legacy skill call when the runtime permission becomes allow",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const project = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir({ git: true })),
          (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
        )
        yield* Effect.promise(() =>
          Promise.all([
            writeSkill(project.path, ".opencode/skills/pending", "ticket-6-legacy", "Pending legacy skill"),
            Bun.write(
              path.join(project.path, "opencode.json"),
              JSON.stringify({ ...testProviderConfig(llm.url), permission: { skill: "ask" } }),
            ),
          ]),
        )
        const listener = yield* Effect.acquireRelease(
          Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 })),
          (server) => Effect.promise(() => server.stop()),
        )
        const sdk = createOpencodeClient({ baseUrl: listener.url.href, directory: project.path })
        const controller = new AbortController()
        const events = yield* Effect.promise(() => sdk.event.subscribe(undefined, { signal: controller.signal }))
        const iterator = events.stream[Symbol.asyncIterator]()
        expect((yield* Effect.promise(() => iterator.next())).value?.type).toBe("server.connected")
        yield* Effect.promise(() =>
          sdk.v2.skill.permission.set(
            { agent: "build", name: "ticket-6-legacy", effect: "ask" },
            { throwOnError: true },
          ),
        )
        const session = yield* Effect.promise(() =>
          sdk.session.create({ title: "Pending legacy skill" }, { throwOnError: true }),
        )
        yield* llm.toolMatch(
          (hit) => JSON.stringify(hit.body).includes("load the pending skill"),
          "skill",
          { name: "ticket-6-legacy" },
        )
        yield* llm.textMatch(
          (hit) => JSON.stringify(hit.body).includes("load the pending skill"),
          "legacy skill completed",
        )
        const prompt = yield* Effect.promise(() =>
          sdk.session.prompt(
            {
              sessionID: session.data.id,
              agent: "build",
              model: { providerID: "test", modelID: "test-model" },
              parts: [{ type: "text", text: "load the pending skill" }],
            },
            { throwOnError: true },
          ),
        ).pipe(Effect.forkScoped)
        const request = yield* pollWithTimeout(
          Effect.promise(() => sdk.permission.list(undefined, { throwOnError: true })).pipe(
            Effect.map((result) => result.data.find((item) => item.sessionID === session.data.id)),
          ),
          "legacy skill request did not become pending",
        )

        yield* Effect.promise(() =>
          sdk.v2.skill.permission.set(
            { agent: "build", name: "ticket-6-legacy", effect: "allow" },
            { throwOnError: true },
          ),
        )

        const pending = yield* Effect.promise(() => sdk.permission.list(undefined, { throwOnError: true }))
        expect(pending.data.map((item) => item.id)).not.toContain(request.id)
        const reply = yield* Effect.promise(() =>
          Promise.race([
            (async () => {
              while (true) {
                const item = await iterator.next()
                if (item.done) throw new Error("Event stream closed before legacy permission reply")
                const payload = (item.value as { payload?: { type: string; properties: unknown } }).payload ?? item.value
                if (payload.type === "permission.replied") return payload
              }
            })(),
            Bun.sleep(2_000).then(() => {
              throw new Error("Timed out waiting for legacy permission reply event")
            }),
          ]),
        )
        expect(reply).toMatchObject({ properties: { requestID: request.id, reply: "once" } })
        yield* Effect.promise(() => iterator.return?.())
        controller.abort()
        yield* Fiber.join(prompt)
      }),
    20_000,
  )

  it.live(
    "keeps or rejects real pending legacy skill calls for ask and deny overrides",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const project = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir({ git: true })),
          (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
        )
        yield* Effect.promise(() =>
          Promise.all([
            writeSkill(project.path, ".opencode/skills/pending", "ticket-6-legacy-effects", "Pending legacy skill"),
            Bun.write(
              path.join(project.path, "opencode.json"),
              JSON.stringify({ ...testProviderConfig(llm.url), permission: { skill: "ask" } }),
            ),
          ]),
        )
        const listener = yield* Effect.acquireRelease(
          Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 })),
          (server) => Effect.promise(() => server.stop()),
        )
        const sdk = createOpencodeClient({ baseUrl: listener.url.href, directory: project.path })
        const set = (effect: "ask" | "deny") =>
          Effect.promise(() =>
            sdk.v2.skill.permission.set(
              { agent: "build", name: "ticket-6-legacy-effects", effect },
              { throwOnError: true },
            ),
          )
        const prompt = (title: string) =>
          Effect.gen(function* () {
            const session = yield* Effect.promise(() => sdk.session.create({ title }, { throwOnError: true }))
            yield* llm.toolMatch(
              (hit) => JSON.stringify(hit.body).includes(title),
              "skill",
              { name: "ticket-6-legacy-effects" },
            )
            yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes(title), `${title} completed`)
            const running = yield* Effect.promise(() =>
              sdk.session.prompt(
                {
                  sessionID: session.data.id,
                  agent: "build",
                  model: { providerID: "test", modelID: "test-model" },
                  parts: [{ type: "text", text: title }],
                },
                { throwOnError: true },
              ),
            ).pipe(Effect.forkScoped)
            const request = yield* pollWithTimeout(
              Effect.promise(() => sdk.permission.list(undefined, { throwOnError: true })).pipe(
                Effect.map((result) => result.data.find((item) => item.sessionID === session.data.id)),
              ),
              `${title} request did not become pending`,
            )
            return { running, request }
          })

        yield* set("ask")
        const asked = yield* prompt("Keep pending legacy skill")
        yield* set("ask")
        const pending = yield* Effect.promise(() => sdk.permission.list(undefined, { throwOnError: true }))
        expect(pending.data.map((item) => item.id)).toContain(asked.request.id)
        yield* Effect.promise(() =>
          sdk.permission.reply({ requestID: asked.request.id, reply: "once" }, { throwOnError: true }),
        )
        yield* Fiber.join(asked.running)

        yield* set("ask")
        const denied = yield* prompt("Reject pending legacy skill")
        yield* set("deny")
        const after = yield* Effect.promise(() => sdk.permission.list(undefined, { throwOnError: true }))
        expect(after.data.map((item) => item.id)).not.toContain(denied.request.id)
        yield* Fiber.join(denied.running)
      }),
    30_000,
  )

  test("reconciles only matching V2 skill requests for each runtime effect", async () => {
    await using project = await tmpdir({ git: true })
    await Promise.all([
      writeSkill(project.path, ".opencode/skills/target", "ticket-6-v2", "Target V2 skill"),
      writeSkill(project.path, ".opencode/skills/other", "ticket-6-other", "Other V2 skill"),
      Bun.write(
        path.join(project.path, "opencode.json"),
        JSON.stringify({ formatter: false, lsp: false, permission: { skill: "ask", bash: "ask" } }),
      ),
    ])

    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      const sdk = createOpencodeClient({ baseUrl: listener.url.href, directory: project.path })
      const session = await sdk.v2.session.create(
        { agent: "build", location: { directory: project.path } },
        { throwOnError: true },
      )
      const sessionID = session.data.data.id
      const request = (action: "skill" | "bash", resource: string) =>
        sdk.v2.session.permission.create(
          { sessionID, action, resources: [resource], agent: "build" },
          { throwOnError: true },
        )
      const pending = async () =>
        (await sdk.v2.session.permission.list({ sessionID }, { throwOnError: true })).data.data.map((item) => item.id)

      const allowed = await request("skill", "ticket-6-v2")
      const otherSkill = await request("skill", "ticket-6-other")
      const otherAction = await request("bash", "echo")
      await sdk.v2.skill.permission.set(
        { agent: "build", name: "ticket-6-v2", effect: "allow" },
        { throwOnError: true },
      )
      expect(await pending()).toEqual(expect.arrayContaining([otherSkill.data.data.id, otherAction.data.data.id]))
      expect(await pending()).not.toContain(allowed.data.data.id)

      await sdk.v2.skill.permission.set(
        { agent: "build", name: "ticket-6-v2", effect: "ask" },
        { throwOnError: true },
      )
      const denied = await request("skill", "ticket-6-v2")
      await sdk.v2.skill.permission.set(
        { agent: "build", name: "ticket-6-v2", effect: "deny" },
        { throwOnError: true },
      )
      expect(await pending()).not.toContain(denied.data.data.id)

      await sdk.v2.skill.permission.set(
        { agent: "build", name: "ticket-6-v2", effect: "ask" },
        { throwOnError: true },
      )
      const asked = await request("skill", "ticket-6-v2")
      await sdk.v2.skill.permission.set(
        { agent: "build", name: "ticket-6-v2", effect: "ask" },
        { throwOnError: true },
      )
      expect(await pending()).toContain(asked.data.data.id)
    } finally {
      await listener.stop()
    }
  })

  test("reconciles every exact wildcard skill request without touching other Sessions, agents, actions, or Locations", async () => {
    await using first = await tmpdir({ git: true })
    await using second = await tmpdir({ git: true })
    await Promise.all(
      [first.path, second.path].flatMap((directory) => [
        writeSkill(directory, ".opencode/skills/target", "ticket-6-exact*", "Exact target"),
        writeSkill(directory, ".opencode/skills/similar", "ticket-6-exact-one", "Similar target"),
        Bun.write(
          path.join(directory, "opencode.json"),
          JSON.stringify({ formatter: false, lsp: false, permission: { skill: "ask", bash: "ask" } }),
        ),
      ]),
    )
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      const firstSdk = createOpencodeClient({ baseUrl: listener.url.href, directory: first.path })
      const secondSdk = createOpencodeClient({ baseUrl: listener.url.href, directory: second.path })
      const create = (sdk: ReturnType<typeof createOpencodeClient>, directory: string, agent: string) =>
        sdk.v2.session.create({ agent, location: { directory } }, { throwOnError: true })
      const [one, two, otherAgent, otherLocation] = await Promise.all([
        create(firstSdk, first.path, "build"),
        create(firstSdk, first.path, "build"),
        create(firstSdk, first.path, "plan"),
        create(secondSdk, second.path, "build"),
      ])
      const ask = (
        sdk: ReturnType<typeof createOpencodeClient>,
        sessionID: string,
        agent: string,
        action: "skill" | "bash",
        resource: string,
      ) => sdk.v2.session.permission.create({ sessionID, agent, action, resources: [resource] }, { throwOnError: true })
      const [firstTarget, secondTarget, agentTarget, locationTarget, otherAction, similar] = await Promise.all([
        ask(firstSdk, one.data.data.id, "build", "skill", "ticket-6-exact*"),
        ask(firstSdk, two.data.data.id, "build", "skill", "ticket-6-exact*"),
        ask(firstSdk, otherAgent.data.data.id, "plan", "skill", "ticket-6-exact*"),
        ask(secondSdk, otherLocation.data.data.id, "build", "skill", "ticket-6-exact*"),
        ask(firstSdk, one.data.data.id, "build", "bash", "echo"),
        ask(firstSdk, one.data.data.id, "build", "skill", "ticket-6-exact-one"),
      ])
      await firstSdk.v2.skill.permission.set(
        { agent: "build", name: "ticket-6-exact*", effect: "allow" },
        { throwOnError: true },
      )
      const pending = async (sdk: ReturnType<typeof createOpencodeClient>, sessionID: string) =>
        (await sdk.v2.session.permission.list({ sessionID }, { throwOnError: true })).data.data.map((item) => item.id)
      expect(await pending(firstSdk, one.data.data.id)).toEqual(expect.arrayContaining([otherAction.data.data.id, similar.data.data.id]))
      expect(await pending(firstSdk, one.data.data.id)).not.toContain(firstTarget.data.data.id)
      expect(await pending(firstSdk, two.data.data.id)).not.toContain(secondTarget.data.data.id)
      expect(await pending(firstSdk, otherAgent.data.data.id)).toContain(agentTarget.data.data.id)
      expect(await pending(secondSdk, otherLocation.data.data.id)).toContain(locationTarget.data.data.id)
    } finally {
      await listener.stop()
    }
  })

  test("settles a concurrent explicit reply and runtime allow exactly once without fan-out or saved approval", async () => {
    await using project = await tmpdir({ git: true })
    await Promise.all([
      writeSkill(project.path, ".opencode/skills/race", "ticket-6-race", "Race skill"),
      Bun.write(
        path.join(project.path, "opencode.json"),
        JSON.stringify({ formatter: false, lsp: false, permission: { skill: "ask", bash: "ask" } }),
      ),
    ])
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    const controller = new AbortController()
    try {
      const sdk = createOpencodeClient({ baseUrl: listener.url.href, directory: project.path })
      const session = await sdk.v2.session.create(
        { agent: "build", location: { directory: project.path } },
        { throwOnError: true },
      )
      const sessionID = session.data.data.id
      await sdk.v2.skill.permission.list({ agent: "build" }, { throwOnError: true })
      const events = await sdk.v2.event.subscribe({ signal: controller.signal })
      const iterator = events.stream[Symbol.asyncIterator]()
      await iterator.next()
      const [raced, unrelated] = await Promise.all([
        sdk.v2.session.permission.create(
          { sessionID, agent: "build", action: "skill", resources: ["ticket-6-race"] },
          { throwOnError: true },
        ),
        sdk.v2.session.permission.create(
          { sessionID, agent: "build", action: "bash", resources: ["echo"] },
          { throwOnError: true },
        ),
      ])
      await sdk.v2.skill.permission.set(
        { agent: "build", name: "ticket-6-race", effect: "ask" },
        { throwOnError: true },
      )
      const settled = await Promise.allSettled([
        sdk.v2.session.permission.reply(
          { sessionID, requestID: raced.data.data.id, reply: "once" },
          { throwOnError: true },
        ),
        sdk.v2.skill.permission.set(
          { agent: "build", name: "ticket-6-race", effect: "allow" },
          { throwOnError: true },
        ),
      ])
      expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(2)
      const pending = await sdk.v2.session.permission.list({ sessionID }, { throwOnError: true })
      expect(pending.data.data.map((item) => item.id)).toEqual([unrelated.data.data.id])
      await sdk.v2.skill.permission.set(
        { agent: "build", name: "ticket-6-race", effect: "ask" },
        { throwOnError: true },
      )
      const after = await sdk.v2.session.permission.create(
        { sessionID, agent: "build", action: "skill", resources: ["ticket-6-race"] },
        { throwOnError: true },
      )
      expect(after.data.data.effect).toBe("ask")
      const replies: unknown[] = []
      const observed: unknown[] = []
      for (const _ of Array.from({ length: 6 })) {
        const next = await iterator.next()
        const event = next.value as { type?: string; data?: { requestID?: string } }
        observed.push(event)
        if (event.type === "permission.v2.replied" && event.data?.requestID === raced.data.data.id) replies.push(event)
      }
      expect(replies, JSON.stringify(observed)).toHaveLength(1)
    } finally {
      controller.abort()
      await listener.stop()
    }
  })

  it.live(
    "reconciles only exact legacy provider requests across runtime effects without reply fan-out or saved approvals",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const first = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir({ git: true })),
          (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
        )
        const second = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir({ git: true })),
          (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
        )
        yield* Effect.promise(() =>
          Promise.all(
            [first.path, second.path].flatMap((directory) => [
              writeSkill(directory, ".opencode/skills/exact", "ticket-6-legacy-exact*", "Exact legacy skill"),
              writeSkill(directory, ".opencode/skills/similar", "ticket-6-legacy-exact-one", "Similar legacy skill"),
              Bun.write(
                path.join(directory, "opencode.json"),
                JSON.stringify({ ...testProviderConfig(llm.url), permission: { skill: "ask", bash: "ask" } }),
              ),
            ]),
          ),
        )
        const listener = yield* Effect.acquireRelease(
          Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 })),
          (server) => Effect.promise(() => server.stop()),
        )
        const firstSdk = createOpencodeClient({ baseUrl: listener.url.href, directory: first.path })
        const secondSdk = createOpencodeClient({ baseUrl: listener.url.href, directory: second.path })
        const controller = new AbortController()
        const events = yield* Effect.promise(() => firstSdk.event.subscribe(undefined, { signal: controller.signal }))
        const iterator = events.stream[Symbol.asyncIterator]()
        expect((yield* Effect.promise(() => iterator.next())).value?.type).toBe("server.connected")
        const observed: unknown[] = []
        const consume = (async () => {
          while (true) {
            const next = await iterator.next()
            if (next.done) return
            observed.push(next.value)
          }
        })()
        const create = (sdk: ReturnType<typeof createOpencodeClient>, title: string) =>
          Effect.promise(() => sdk.session.create({ title }, { throwOnError: true }))
        const prompt = (
          sdk: ReturnType<typeof createOpencodeClient>,
          sessionID: string,
          agent: "build" | "plan",
          title: string,
          tool: "skill",
          permission: "skill",
          args: Record<string, string>,
        ) =>
          Effect.gen(function* () {
            yield* llm.toolMatch((hit) => JSON.stringify(hit.body).includes(title), tool, args)
            yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes(title), `${title} completed`)
            const running = yield* Effect.promise(() =>
              sdk.session.prompt(
                {
                  sessionID,
                  agent,
                  model: { providerID: "test", modelID: "test-model" },
                  parts: [{ type: "text", text: title }],
                },
                { throwOnError: true },
              ),
            ).pipe(Effect.forkScoped)
            const request = yield* pollWithTimeout(
              Effect.promise(() => sdk.permission.list(undefined, { throwOnError: true })).pipe(
                Effect.map((result) =>
                  result.data.find((item) => item.sessionID === sessionID && item.permission === permission),
                ),
              ),
              `${title} request did not become pending`,
            )
            return { running, request }
          })

        const firstSession = yield* create(firstSdk, "Legacy exact reply race")
        const siblingSession = yield* create(firstSdk, "Legacy exact runtime allow")
        const agentSession = yield* create(firstSdk, "Legacy other agent")
        const similarSession = yield* create(firstSdk, "Legacy similar skill")
        const locationSession = yield* create(secondSdk, "Legacy other location")
        const raced = yield* prompt(
          firstSdk,
          firstSession.data.id,
          "build",
          "Legacy exact reply race",
          "skill",
          "skill",
          { name: "ticket-6-legacy-exact*" },
        )
        const unrelated = yield* Effect.promise(() =>
          firstSdk.v2.session.permission.create(
            { sessionID: firstSession.data.id, agent: "build", action: "bash", resources: ["echo pending"] },
            { throwOnError: true },
          ),
        )
        const sibling = yield* prompt(
          firstSdk,
          siblingSession.data.id,
          "build",
          "Legacy exact runtime allow",
          "skill",
          "skill",
          { name: "ticket-6-legacy-exact*" },
        )
        const otherAgent = yield* prompt(
          firstSdk,
          agentSession.data.id,
          "plan",
          "Legacy other agent",
          "skill",
          "skill",
          { name: "ticket-6-legacy-exact*" },
        )
        const similar = yield* prompt(
          firstSdk,
          similarSession.data.id,
          "build",
          "Legacy similar skill",
          "skill",
          "skill",
          { name: "ticket-6-legacy-exact-one" },
        )
        const otherLocation = yield* prompt(
          secondSdk,
          locationSession.data.id,
          "build",
          "Legacy other location",
          "skill",
          "skill",
          { name: "ticket-6-legacy-exact*" },
        )

        // A once reply wins the controlled race, so the subsequent runtime update cannot save or fan out the approval.
        yield* Effect.promise(() =>
          firstSdk.permission.reply({ requestID: raced.request.id, reply: "once" }, { throwOnError: true }),
        )
        yield* Effect.promise(() =>
          firstSdk.v2.skill.permission.set(
            { agent: "build", name: "ticket-6-legacy-exact*", effect: "allow" },
            { throwOnError: true },
          ),
        )
        yield* Fiber.join(raced.running)
        yield* Fiber.join(sibling.running)
        const pending = yield* Effect.promise(() => firstSdk.permission.list(undefined, { throwOnError: true }))
        expect(pending.data.map((item) => item.id)).toEqual(expect.arrayContaining([otherAgent.request.id, similar.request.id]))
        expect(pending.data.map((item) => item.id)).not.toContain(sibling.request.id)
        expect(
          (yield* Effect.promise(() =>
            firstSdk.v2.session.permission.list({ sessionID: firstSession.data.id }, { throwOnError: true }),
          )).data.data.map((item) => item.id),
        ).toContain(unrelated.data.data.id)
        const otherLocationPending = yield* Effect.promise(() => secondSdk.permission.list(undefined, { throwOnError: true }))
        expect(otherLocationPending.data.map((item) => item.id)).toContain(otherLocation.request.id)

        yield* Effect.promise(() =>
          firstSdk.v2.skill.permission.set(
            { agent: "build", name: "ticket-6-legacy-exact*", effect: "ask" },
            { throwOnError: true },
          ),
        )
        const afterSession = yield* create(firstSdk, "Legacy no saved approval")
        const after = yield* prompt(
          firstSdk,
          afterSession.data.id,
          "build",
          "Legacy no saved approval",
          "skill",
          "skill",
          { name: "ticket-6-legacy-exact*" },
        )
        expect((yield* Effect.promise(() => firstSdk.permission.list(undefined, { throwOnError: true }))).data.map((item) => item.id)).toContain(
          after.request.id,
        )
        yield* Effect.promise(() =>
          firstSdk.v2.skill.permission.set(
            { agent: "build", name: "ticket-6-legacy-exact*", effect: "deny" },
            { throwOnError: true },
          ),
        )
        yield* Fiber.join(after.running)
        yield* Effect.promise(() =>
          firstSdk.permission.reply({ requestID: otherAgent.request.id, reply: "once" }, { throwOnError: true }),
        )
        yield* Effect.promise(() =>
          firstSdk.v2.skill.permission.set(
            { agent: "build", name: "ticket-6-legacy-exact-one", effect: "deny" },
            { throwOnError: true },
          ),
        )
        yield* Effect.promise(() =>
          secondSdk.v2.skill.permission.set(
            { agent: "build", name: "ticket-6-legacy-exact*", effect: "deny" },
            { throwOnError: true },
          ),
        )
        yield* Fiber.join(otherAgent.running)
        yield* Fiber.join(similar.running)
        yield* Fiber.join(otherLocation.running)

        yield* pollWithTimeout(
          Effect.sync(() =>
            observed.some(
              (event) =>
                (event as { type?: string; properties?: { requestID?: string } }).type === "permission.replied" &&
                (event as { properties?: { requestID?: string } }).properties?.requestID === raced.request.id,
            )
              ? true
              : undefined,
          ),
          "legacy explicit reply was not published",
        )
        yield* Effect.promise(() => iterator.return?.())
        yield* Effect.promise(() => consume)
        const replies = observed.filter(
          (event) =>
            (event as { type?: string; properties?: { requestID?: string } }).type === "permission.replied" &&
            (event as { properties?: { requestID?: string } }).properties?.requestID === raced.request.id,
        )
        expect(replies, JSON.stringify(observed)).toHaveLength(1)
        controller.abort()
        yield* llm.reset
      }),
    30_000,
  )

  it.live(
    "keeps wildcard characters in runtime skill names exact for legacy turns",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const project = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir({ git: true })),
          (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
        )
        yield* Effect.promise(() =>
          Promise.all([
            writeSkill(project.path, ".opencode/skills/star", "ticket-5-literal*", "Allowed literal wildcard skill"),
            writeSkill(project.path, ".opencode/skills/question", "ticket-5-literal?", "Denied similar skill"),
            Bun.write(
              path.join(project.path, "opencode.json"),
              JSON.stringify({ ...testProviderConfig(llm.url), permission: { skill: "deny" } }),
            ),
          ]),
        )
        const listener = yield* Effect.acquireRelease(
          Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 })),
          (server) => Effect.promise(() => server.stop()),
        )
        const sdk = createOpencodeClient({ baseUrl: listener.url.href, directory: project.path })
        yield* Effect.promise(() =>
          sdk.v2.skill.permission.set(
            { agent: "build", name: "ticket-5-literal*", effect: "allow" },
            { throwOnError: true },
          ),
        )
        const session = yield* Effect.promise(() =>
          sdk.session.create({ title: "Exact wildcard skill permission" }, { throwOnError: true }),
        )

        yield* llm.text("completed exact wildcard test")
        yield* Effect.promise(() =>
          sdk.session.prompt(
            {
              sessionID: session.data.id,
              agent: "build",
              model: { providerID: "test", modelID: "test-model" },
              parts: [{ type: "text", text: "test exact wildcard permissions" }],
            },
            { throwOnError: true },
          ),
        )
        yield* llm.wait(1)

        const input = JSON.stringify((yield* llm.inputs).at(-1))
        expect(input).toContain("ticket-5-literal*")
        expect(input).not.toContain("ticket-5-literal?")
      }),
    20_000,
  )

  it.live(
    "keeps explicit user skill selection available under runtime deny",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const project = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir({ git: true })),
          (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
        )
        yield* Effect.promise(() =>
          Promise.all([
            writeSkill(project.path, ".opencode/skills/direct", "ticket-5-direct", "Direct legacy skill"),
            Bun.write(path.join(project.path, "opencode.json"), JSON.stringify(testProviderConfig(llm.url))),
          ]),
        )
        const listener = yield* Effect.acquireRelease(
          Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 })),
          (server) => Effect.promise(() => server.stop()),
        )
        const sdk = createOpencodeClient({ baseUrl: listener.url.href, directory: project.path })
        const denied = yield* Effect.promise(() =>
          sdk.v2.skill.permission.set(
            { agent: "build", name: "ticket-5-direct", effect: "deny" },
            { throwOnError: true },
          ),
        )
        expect(denied.data.data.effect).toBe("deny")
        const session = yield* Effect.promise(() =>
          sdk.session.create({ title: "Direct denied skill" }, { throwOnError: true }),
        )

        yield* llm.text("direct skill completed")
        yield* Effect.promise(() =>
          sdk.session.command(
            {
              sessionID: session.data.id,
              agent: "build",
              model: "test/test-model",
              command: "ticket-5-direct",
              arguments: "",
            },
            { throwOnError: true },
          ),
        )
        yield* llm.wait(1)

        const input = (yield* llm.inputs).at(-1)
        expect(JSON.stringify(input?.messages)).toContain("# ticket-5-direct")
      }),
    20_000,
  )
})
