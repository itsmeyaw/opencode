/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createSignal, onCleanup, onMount } from "solid-js"
import { DialogSkill } from "../../src/component/dialog-skill"
import { TuiConfigProvider } from "../../src/config"
import type { TuiKeybind } from "../../src/config/keybind"
import { ClipboardProvider } from "../../src/context/clipboard"
import { KVProvider } from "../../src/context/kv"
import { SDKProvider } from "../../src/context/sdk"
import { ThemeProvider } from "../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { Toast, ToastProvider } from "../../src/ui/toast"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { directory, eventSource, json } from "../fixture/tui-sdk"

const location = { directory, project: { id: "proj_test", directory } }

async function wait(fn: () => boolean, message = "condition", timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${message}`)
    await Bun.sleep(10)
  }
}

async function mountDialog(input: {
  root: string
  fetch: typeof fetch
  agent?: string
  sessionID?: string
  keybinds?: Partial<TuiKeybind.Keybinds>
  onSelect?: (skill: string) => void
}) {
  const state = path.join(input.root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const [agent, setAgent] = createSignal(input.agent ?? "build")

  function OpenDialog() {
    const dialog = useDialog()
    onMount(() =>
      dialog.replace(() => (
        <DialogSkill agent={agent()} sessionID={input.sessionID} onSelect={input.onSelect ?? (() => {})} />
      )),
    )
    return <Toast />
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({ keybinds: input.keybinds })
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)

    return (
      <TestTuiContexts paths={{ home: input.root, state, worktree: input.root }}>
        <SDKProvider url="http://test" directory={directory} events={eventSource()} fetch={input.fetch}>
          <OpencodeKeymapProvider keymap={keymap}>
            <TuiConfigProvider config={config}>
              <KVProvider>
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <ClipboardProvider value={{}}>
                      <DialogProvider>
                        <OpenDialog />
                      </DialogProvider>
                    </ClipboardProvider>
                  </ToastProvider>
                </ThemeProvider>
              </KVProvider>
            </TuiConfigProvider>
          </OpencodeKeymapProvider>
        </SDKProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 100, height: 30, kittyKeyboard: true })
  return {
    app,
    setAgent,
    async cleanup() {
      app.renderer.destroy()
    },
  }
}

test("shows authoritative skill permissions for the selected agent and Session", async () => {
  await using tmp = await tmpdir()
  const requests: URL[] = []
  const fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname !== "/api/skill/permission") throw new Error(`unexpected request: ${url.pathname}`)
    requests.push(url)
    return json({
      location,
      data: [
        {
          name: "review",
          description: "Review changes",
          location: "/skills/review/SKILL.md",
          content: "# Review",
          effect: "ask",
        },
        {
          name: "deploy",
          description: "Deploy safely",
          location: "/skills/deploy/SKILL.md",
          content: "# Deploy",
          effect: "allow",
        },
        {
          name: "audit",
          description: "Audit changes",
          location: "/skills/audit/SKILL.md",
          content: "# Audit",
          effect: "deny",
        },
      ],
    })
  }) as typeof globalThis.fetch
  const dialog = await mountDialog({ root: tmp.path, fetch, agent: "plan", sessionID: "ses_test" })

  try {
    await wait(() => {
      const frame = dialog.app.captureCharFrame()
      return frame.includes("Denied") || frame.includes("Could not load skills")
    })
    const frame = dialog.app.captureCharFrame()
    expect(frame).toContain("review")
    expect(frame).toContain("Ask")
    expect(frame).toContain("deploy")
    expect(frame).toContain("Allowed")
    expect(frame).toContain("audit")
    expect(frame).toContain("Denied")
    expect(requests).toHaveLength(1)
    expect(requests[0]?.searchParams.get("agent")).toBe("plan")
    expect(requests[0]?.searchParams.get("sessionID")).toBe("ses_test")
    expect(requests[0]?.searchParams.get("location[directory]")).toBe(directory)
  } finally {
    await dialog.cleanup()
  }
})

test("cycles the selected permission with Space and refreshes authoritative state", async () => {
  await using tmp = await tmpdir()
  const mutations: Array<{ agent: string; name: string; effect: string }> = []
  let reads = 0
  let effect = "ask"
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname !== "/api/skill/permission") throw new Error(`unexpected request: ${url.pathname}`)
    if (request.method === "PUT") {
      const body = (await request.json()) as { agent: string; name: string; effect: string }
      mutations.push(body)
      effect = body.effect
      return json({ location, data: { name: body.name, effect: body.effect } })
    }
    reads++
    return json({
      location,
      data: [
        {
          name: "review",
          description: "Review changes",
          location: "/skills/review/SKILL.md",
          content: "# Review",
          effect: "deny",
        },
        {
          name: "deploy",
          description: "Deploy safely",
          location: "/skills/deploy/SKILL.md",
          content: "# Deploy",
          effect,
        },
      ],
    })
  }) as typeof globalThis.fetch
  const dialog = await mountDialog({ root: tmp.path, fetch })

  try {
    await wait(() => dialog.app.captureCharFrame().includes("deploy"))
    dialog.app.mockInput.pressArrow("down")

    dialog.app.mockInput.pressKey(" ")
    await wait(() => mutations.length === 1 && reads === 2, "first cycle")
    await dialog.app.flush()
    await wait(() => !dialog.app.captureCharFrame().includes("Loading"), "first cycle rendering")
    expect(mutations[0]).toEqual({ agent: "build", name: "deploy", effect: "allow" })
    expect(reads).toBe(2)
    expect(
      dialog.app
        .captureCharFrame()
        .split("\n")
        .find((line) => line.includes("deploy")),
    ).toContain("Allowed")
    expect(dialog.app.captureCharFrame()).toContain("Skills")

    dialog.app.mockInput.pressKey(" ")
    await wait(() => mutations.length === 2 && reads === 3, "second cycle")
    await dialog.app.flush()
    await wait(() => !dialog.app.captureCharFrame().includes("Loading"), "second cycle rendering")
    expect(mutations[1]).toEqual({ agent: "build", name: "deploy", effect: "deny" })
    expect(reads).toBe(3)
    expect(
      dialog.app
        .captureCharFrame()
        .split("\n")
        .find((line) => line.includes("deploy")),
    ).toContain("Denied")

    dialog.app.mockInput.pressKey(" ")
    await wait(() => mutations.length === 3 && reads === 4, "third cycle")
    await dialog.app.flush()
    await wait(() => !dialog.app.captureCharFrame().includes("Loading"), "third cycle rendering")
    expect(mutations[2]).toEqual({ agent: "build", name: "deploy", effect: "ask" })
    expect(reads).toBe(4)
    expect(
      dialog.app
        .captureCharFrame()
        .split("\n")
        .find((line) => line.includes("deploy")),
    ).toContain("Ask")
  } finally {
    await dialog.cleanup()
  }
})

test("locks mutation input while loading and preserves authoritative state on failure", async () => {
  await using tmp = await tmpdir()
  let effect = "ask"
  let mutations = 0
  let finishMutation!: (response: Response) => void
  const pendingMutation = new Promise<Response>((resolve) => {
    finishMutation = resolve
  })
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname !== "/api/skill/permission") throw new Error(`unexpected request: ${url.pathname}`)
    if (request.method === "PUT") {
      mutations++
      if (mutations === 1) return pendingMutation
      return json({ message: "permission service unavailable" }, { status: 503 })
    }
    return json({
      location,
      data: [
        {
          name: "review",
          description: "Review changes",
          location: "/skills/review/SKILL.md",
          content: "# Review",
          effect,
        },
      ],
    })
  }) as typeof globalThis.fetch
  const dialog = await mountDialog({ root: tmp.path, fetch })

  try {
    await wait(() => dialog.app.captureCharFrame().includes("Ask"))
    dialog.app.mockInput.pressKey(" ")
    await wait(() => dialog.app.captureCharFrame().includes("Loading"))
    dialog.app.mockInput.pressKey(" ")
    await Bun.sleep(20)
    expect(mutations).toBe(1)

    effect = "allow"
    finishMutation(json({ location, data: { name: "review", effect: "allow" } }))
    await wait(() => dialog.app.captureCharFrame().includes("Allowed"))

    dialog.app.mockInput.pressKey(" ")
    await wait(() => dialog.app.captureCharFrame().includes("Could not update skill permission"))
    const frame = dialog.app.captureCharFrame()
    expect(mutations).toBe(2)
    expect(frame.split("\n").find((line) => line.includes("review"))).toContain("Allowed")
    expect(frame).toContain("permission service unavailable")
    expect(frame).toContain("Skills")
  } finally {
    await dialog.cleanup()
  }
})

test("refreshes permissions when the selected agent changes before a Session exists", async () => {
  await using tmp = await tmpdir()
  const requests: URL[] = []
  const fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname !== "/api/skill/permission") throw new Error(`unexpected request: ${url.pathname}`)
    requests.push(url)
    const agent = url.searchParams.get("agent")
    return json({
      location,
      data: [
        {
          name: "review",
          description: "Review changes",
          location: "/skills/review/SKILL.md",
          content: "# Review",
          effect: agent === "plan" ? "deny" : "allow",
        },
      ],
    })
  }) as typeof globalThis.fetch
  const dialog = await mountDialog({ root: tmp.path, fetch })

  try {
    await wait(() => dialog.app.captureCharFrame().includes("Allowed"))
    expect(requests[0]?.searchParams.get("agent")).toBe("build")
    expect(requests[0]?.searchParams.has("sessionID")).toBe(false)

    dialog.setAgent("plan")
    await wait(() => requests.length === 2 && dialog.app.captureCharFrame().includes("Denied"))
    expect(requests[1]?.searchParams.get("agent")).toBe("plan")
    expect(requests[1]?.searchParams.has("sessionID")).toBe(false)
    expect(dialog.app.captureCharFrame()).toContain("Skills")
  } finally {
    await dialog.cleanup()
  }
})

test("ignores a stale load failure after the selected agent changes", async () => {
  await using tmp = await tmpdir()
  let finishBuild!: (response: Response) => void
  const build = new Promise<Response>((resolve) => {
    finishBuild = resolve
  })
  const fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname !== "/api/skill/permission") throw new Error(`unexpected request: ${url.pathname}`)
    if (url.searchParams.get("agent") === "build") return build
    return json({
      location,
      data: [
        {
          name: "review",
          description: "Review changes",
          location: "/skills/review/SKILL.md",
          content: "# Review",
          effect: "deny",
        },
      ],
    })
  }) as typeof globalThis.fetch
  const dialog = await mountDialog({ root: tmp.path, fetch })

  try {
    dialog.setAgent("plan")
    await wait(() => dialog.app.captureCharFrame().includes("Denied"))
    finishBuild(json({ message: "stale build failure" }, { status: 503 }))
    await Bun.sleep(20)
    expect(dialog.app.captureCharFrame()).toContain("Denied")
    expect(dialog.app.captureCharFrame()).not.toContain("Could not load skills")
  } finally {
    await dialog.cleanup()
  }
})

test("uses the configured permission-cycle binding instead of Space", async () => {
  await using tmp = await tmpdir()
  let effect = "ask"
  let mutations = 0
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname !== "/api/skill/permission") throw new Error(`unexpected request: ${url.pathname}`)
    if (request.method === "PUT") {
      mutations++
      effect = "allow"
      return json({ location, data: { name: "review", effect } })
    }
    return json({
      location,
      data: [
        {
          name: "review",
          description: "Review changes",
          location: "/skills/review/SKILL.md",
          content: "# Review",
          effect,
        },
      ],
    })
  }) as typeof globalThis.fetch
  const dialog = await mountDialog({
    root: tmp.path,
    fetch,
    keybinds: { "dialog.skill.permission.cycle": "ctrl+y" },
  })

  try {
    await wait(() => dialog.app.captureCharFrame().includes("Ask"))
    expect(dialog.app.captureCharFrame()).toContain("ctrl+y")
    dialog.app.mockInput.pressKey(" ")
    await Bun.sleep(20)
    expect(mutations).toBe(0)
    dialog.app.mockInput.pressBackspace()

    dialog.app.mockInput.pressKey("y", { ctrl: true })
    await wait(() => mutations === 1 && dialog.app.captureCharFrame().includes("Allowed"))
    expect(dialog.app.captureCharFrame()).toContain("Skills")
  } finally {
    await dialog.cleanup()
  }
})

test("Enter directly selects a denied skill and closes the dialog", async () => {
  await using tmp = await tmpdir()
  const selected: string[] = []
  const fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname !== "/api/skill/permission") throw new Error(`unexpected request: ${url.pathname}`)
    return json({
      location,
      data: [
        {
          name: "review",
          description: "Review changes",
          location: "/skills/review/SKILL.md",
          content: "# Review",
          effect: "deny",
        },
      ],
    })
  }) as typeof globalThis.fetch
  const dialog = await mountDialog({ root: tmp.path, fetch, onSelect: (skill) => selected.push(skill) })

  try {
    await wait(() => dialog.app.captureCharFrame().includes("Denied"))
    dialog.app.mockInput.pressEnter()
    await wait(() => selected.length === 1 && !dialog.app.captureCharFrame().includes("Skills"))
    expect(selected).toEqual(["review"])
    expect(dialog.app.captureCharFrame()).not.toContain("Skills")
  } finally {
    await dialog.cleanup()
  }
})
