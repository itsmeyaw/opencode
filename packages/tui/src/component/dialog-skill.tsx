import { TextAttributes } from "@opentui/core"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { createResource, createMemo, createSignal } from "solid-js"
import { useDialog } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { errorMessage } from "../util/error"
import { useToast } from "../ui/toast"
import type { LocationRef, PermissionV2Effect } from "@opencode-ai/sdk/v2"

export type DialogSkillProps = {
  agent: string
  sessionID?: string
  location: LocationRef
  onSelect: (skill: string) => void
}

type PermissionRequest = {
  agent: string
  sessionID?: string
  location: { directory: string; workspace?: string }
}

function Status(props: { effect: PermissionV2Effect; loading: boolean }) {
  const { theme } = useTheme()
  const label = createMemo(() => {
    if (props.loading) return "⋯ Loading"
    if (props.effect === "allow") return "Allowed"
    if (props.effect === "deny") return "Denied"
    return "Ask"
  })
  const color = createMemo(() => {
    if (props.loading) return theme.textMuted
    if (props.effect === "allow") return theme.success
    if (props.effect === "deny") return theme.error
    return theme.warning
  })
  return <span style={{ fg: color(), attributes: props.loading ? undefined : TextAttributes.BOLD }}>{label()}</span>
}

export function DialogSkill(props: DialogSkillProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const { theme } = useTheme()
  dialog.setSize("large")

  const [loadError, setLoadError] = createSignal<unknown>()
  const [loading, setLoading] = createSignal<(PermissionRequest & { name: string }) | undefined>()

  const load = (request: PermissionRequest) =>
    sdk.client.v2.skill.permission.list(request, { throwOnError: true }).then((result) => result.data.data)

  const [skills, { mutate }] = createResource(
    () => ({
      agent: props.agent,
      sessionID: props.sessionID,
      location: { directory: props.location.directory, workspace: props.location.workspaceID },
    }),
    (request) => {
      setLoadError(undefined)
      return (
        load(request)
          // Catch so the rejected resource never reaches the memo below: reading
          // skills() in an errored state re-throws and tears down the dialog.
          .catch((error) => {
            setLoadError(error)
            return undefined
          })
      )
    },
  )

  const showError = createMemo(() => Boolean(loadError()))
  const showLoading = createMemo(() => skills.loading)

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    if (showError() || showLoading()) return []
    const list = skills() ?? []
    const maxWidth = Math.max(0, ...list.map((s) => s.name.length))
    return list.map((skill) => ({
      title: skill.name.padEnd(maxWidth),
      description: skill.description?.replace(/\s+/g, " ").trim(),
      footer: (
        <Status
          effect={skill.effect}
          loading={
            loading()?.name === skill.name &&
            loading()?.agent === props.agent &&
            loading()?.sessionID === props.sessionID &&
            loading()?.location.directory === props.location.directory &&
            loading()?.location.workspace === props.location.workspaceID
          }
        />
      ),
      value: skill.name,
      category: "Skills",
      onSelect: () => {
        props.onSelect(skill.name)
        dialog.clear()
      },
    }))
  })

  const actions = createMemo(() => [
    {
      command: "dialog.skill.permission.cycle",
      title: "cycle permission",
      disabled: () => loading() !== undefined || showLoading(),
      onTrigger: async (option: DialogSelectOption<string>) => {
        if (loading() !== undefined || showLoading()) return
        const skill = skills()?.find((item) => item.name === option.value)
        if (!skill) return
        const request = {
          agent: props.agent,
          sessionID: props.sessionID,
          location: { directory: props.location.directory, workspace: props.location.workspaceID },
        }
        const effect: PermissionV2Effect =
          skill.effect === "ask" ? "allow" : skill.effect === "allow" ? "deny" : "ask"
        const current = () =>
          props.agent === request.agent &&
          props.sessionID === request.sessionID &&
          props.location.directory === request.location.directory &&
          props.location.workspaceID === request.location.workspace
        setLoading({ ...request, name: skill.name })
        try {
          const result = await sdk.client.v2.skill.permission.set(
            { agent: request.agent, name: skill.name, effect, location: request.location },
            { throwOnError: true },
          )
          const refreshed = await load(request).catch((error) => {
            if (current()) {
              mutate((list) =>
                list?.map((item) =>
                  item.name === result.data.data.name ? { ...item, effect: result.data.data.effect } : item,
                ),
              )
            }
            toast.show({
              title: "Skill permission changed; refresh failed",
              message: errorMessage(error),
              variant: "error",
            })
          })
          if (refreshed && current()) mutate(refreshed)
        } catch (error) {
          toast.show({
            title: "Could not update skill permission",
            message: errorMessage(error),
            variant: "error",
          })
        } finally {
          setLoading(undefined)
        }
      },
    },
  ])

  return (
    <DialogSelect
      title="Skills"
      placeholder="Search skills..."
      options={options()}
      actions={actions()}
      preserveSelection
      renderFilter={!showError()}
      locked={showError() || showLoading()}
      emptyView={
        showError() ? (
          <box paddingLeft={4} paddingRight={4}>
            <text fg={theme.error} attributes={TextAttributes.BOLD}>
              Could not load skills
            </text>
            <text fg={theme.textMuted}>{errorMessage(loadError())}</text>
          </box>
        ) : showLoading() ? (
          <box paddingLeft={4} paddingRight={4}>
            <text fg={theme.textMuted}>Loading skills...</text>
          </box>
        ) : undefined
      }
    />
  )
}
