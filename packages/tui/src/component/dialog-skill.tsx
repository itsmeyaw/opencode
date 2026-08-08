import { TextAttributes } from "@opentui/core"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { createResource, createMemo, createSignal } from "solid-js"
import { useDialog } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { errorMessage } from "../util/error"
import { useToast } from "../ui/toast"

export type DialogSkillProps = {
  agent: string
  sessionID?: string
  onSelect: (skill: string) => void
}

type Effect = "allow" | "ask" | "deny"

function Status(props: { effect: Effect; loading: boolean }) {
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
  const [loading, setLoading] = createSignal<string>()

  const load = (request: { agent: string; sessionID?: string }) =>
    sdk.client.v2.skill.permission.list(request, { throwOnError: true }).then((result) => result.data.data)

  const [skills, { mutate }] = createResource(
    () => ({ agent: props.agent, sessionID: props.sessionID }),
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

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    if (showError()) return []
    const list = skills() ?? []
    const maxWidth = Math.max(0, ...list.map((s) => s.name.length))
    return list.map((skill) => ({
      title: skill.name.padEnd(maxWidth),
      description: skill.description?.replace(/\s+/g, " ").trim(),
      footer: <Status effect={skill.effect} loading={loading() === skill.name} />,
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
      disabled: () => loading() !== undefined,
      onTrigger: async (option: DialogSelectOption<string>) => {
        if (loading() !== undefined) return
        const skill = skills()?.find((item) => item.name === option.value)
        if (!skill) return
        const request = { agent: props.agent, sessionID: props.sessionID }
        const effect: Effect = skill.effect === "ask" ? "allow" : skill.effect === "allow" ? "deny" : "ask"
        setLoading(skill.name)
        try {
          await sdk.client.v2.skill.permission.set(
            { agent: request.agent, name: skill.name, effect },
            { throwOnError: true },
          )
          const refreshed = await load(request)
          if (props.agent === request.agent && props.sessionID === request.sessionID) mutate(refreshed)
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
      locked={showError()}
      emptyView={
        showError() ? (
          <box paddingLeft={4} paddingRight={4}>
            <text fg={theme.error} attributes={TextAttributes.BOLD}>
              Could not load skills
            </text>
            <text fg={theme.textMuted}>{errorMessage(loadError())}</text>
          </box>
        ) : undefined
      }
    />
  )
}
