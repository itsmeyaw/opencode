import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const environment = [
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_TEST_HOME",
  "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS",
  "OPENCODE_DISABLE_EXTERNAL_SKILLS",
] as const

const original = Object.fromEntries(environment.map((key) => [key, process.env[key]]))

afterEach(async () => {
  for (const key of environment) {
    const value = original[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
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

function sortedNames(skills: ReadonlyArray<{ name: string }>) {
  return skills.map((skill) => skill.name).toSorted()
}

function enableExternalSources() {
  process.env.OPENCODE_DISABLE_CLAUDE_CODE = "false"
  process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = "false"
  process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "false"
}

describe("skill HttpApi", () => {
  test("matches the user-visible inventory for OpenCode, path, URL, built-in, and duplicate sources", async () => {
    await using home = await tmpdir()
    await using project = await tmpdir({ git: true })
    using catalog = Bun.serve({
      port: 0,
      fetch(request) {
        const pathname = new URL(request.url).pathname
        if (pathname === "/catalog/index.json") {
          return Response.json({
            skills: [{ name: "ticket-2-url", version: "1", files: ["SKILL.md"] }],
          })
        }
        if (pathname === "/catalog/ticket-2-url/SKILL.md") {
          return new Response(`---\nname: ticket-2-url\ndescription: URL skill\n---\n# URL skill`)
        }
        return new Response("Not Found", { status: 404 })
      },
    })

    process.env.OPENCODE_TEST_HOME = home.path
    process.env.OPENCODE_CONFIG_DIR = path.join(home.path, "config")
    enableExternalSources()
    await Promise.all([
      writeSkill(process.env.OPENCODE_CONFIG_DIR, "skills/global-opencode", "ticket-2-global", "Global OpenCode skill"),
      writeSkill(project.path, ".opencode/skill/project", "ticket-2-project", "Project OpenCode skill"),
      writeSkill(project.path, "extra/path", "ticket-2-path", "Configured path skill"),
      writeSkill(project.path, "extra/customize", "customize-opencode", "Configured duplicate"),
      Bun.write(
        path.join(project.path, "opencode.json"),
        JSON.stringify({
          formatter: false,
          lsp: false,
          skills: {
            paths: ["./extra"],
            urls: [`http://127.0.0.1:${catalog.port}/catalog/`],
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

      expect(sortedNames(current.data.data)).toEqual(sortedNames(legacy.data))
      expect(sortedNames(current.data.data)).toEqual([
        "customize-opencode",
        "ticket-2-global",
        "ticket-2-path",
        "ticket-2-project",
        "ticket-2-url",
      ])
      expect(current.data.data.map((skill) => skill.name)).toEqual(repeated.data.data.map((skill) => skill.name))
      expect(current.data.data.find((skill) => skill.name === "customize-opencode")).toMatchObject({
        description: "Configured duplicate",
        location: path.join(project.path, "extra", "customize", "SKILL.md"),
      })
    } finally {
      await listener.stop()
    }
  })

  test("matches eligible global and project Claude and agent skill sources", async () => {
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

      expect(sortedNames(current.data.data)).toEqual(sortedNames(legacy.data))
      expect(sortedNames(current.data.data)).toEqual([
        "customize-opencode",
        "ticket-2-global-agent",
        "ticket-2-global-claude",
        "ticket-2-opencode",
        "ticket-2-project-agent",
        "ticket-2-project-claude",
      ])
    } finally {
      await listener.stop()
    }
  })

  test("preserves direct and broad Claude skill disable flags", async () => {
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

        expect(sortedNames(current.data.data)).toEqual(sortedNames(legacy.data))
        expect(sortedNames(current.data.data)).toEqual([
          "customize-opencode",
          "ticket-2-global-agent",
          "ticket-2-opencode",
          "ticket-2-project-agent",
        ])
      } finally {
        await listener.stop()
        delete process.env[flag]
      }
    }
  })

  test("external disable excludes only automatic Claude and agent sources", async () => {
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

      expect(sortedNames(current.data.data)).toEqual(sortedNames(legacy.data))
      expect(sortedNames(current.data.data)).toEqual(["customize-opencode", "ticket-2-opencode", "ticket-2-path"])
    } finally {
      await listener.stop()
    }
  })
})
