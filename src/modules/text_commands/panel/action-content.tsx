import { useEffect, useState, type ReactElement } from "react";

import type { ModuleImmediateActionContentProperties } from "../../contract";
import { LoadStateLines, Select } from "../../../dashboard/ui";
import { readLastCounterVariable, rememberLastCounterVariable } from "./counter-selection";
import { textCommandQuickActionTexts } from "./quick-action-locale";
import { loadTextCommandData, type TextCommandChannelVariable } from "./service";

interface CounterVariablesState {
  channelId: string;
  variables: readonly TextCommandChannelVariable[] | null;
  failed: boolean;
}

interface CounterSelectionState {
  channelId: string;
  name: string | null;
}

export default function CounterActionContent({ channelId, language, onReadinessChange }: ModuleImmediateActionContentProperties): ReactElement {
  const texts = textCommandQuickActionTexts.counter;
  const [variablesState, setVariablesState] = useState<CounterVariablesState>({ channelId, variables: null, failed: false });
  const [selectionState, setSelectionState] = useState<CounterSelectionState>(() => ({
    channelId,
    name: readLastCounterVariable(channelId),
  }));

  useEffect(() => {
    const controller = new AbortController();
    void loadTextCommandData(channelId, controller.signal).then(({ variables }) => {
      if (!controller.signal.aborted) setVariablesState({ channelId, variables, failed: false });
    }).catch(() => {
      if (!controller.signal.aborted) setVariablesState({ channelId, variables: [], failed: true });
    });
    return () => { controller.abort(); };
  }, [channelId]);

  const variables = variablesState.channelId === channelId ? variablesState.variables : null;
  const numericVariables = variables?.filter((variable) => Number.isFinite(variable.value)) ?? null;
  const savedSelection = selectionState.channelId === channelId ? selectionState.name : readLastCounterVariable(channelId);
  const selectedName = numericVariables?.some((variable) => variable.name === savedSelection) === true
    ? savedSelection
    : numericVariables?.[0]?.name ?? null;
  const ready = numericVariables !== null && !variablesState.failed && selectedName !== null &&
    numericVariables.some((variable) => variable.name === selectedName);
  const readinessReason = ready
    ? null
    : variables === null
      ? texts.loading[language]
      : variablesState.failed
        ? texts.loadFailed[language]
        : texts.noVariables[language];

  useEffect(() => {
    onReadinessChange?.(ready, readinessReason);
  }, [onReadinessChange, readinessReason, ready]);

  return <div className="live-action-content live-action-content--counter" aria-busy={variables === null}>
    {variables === null
      ? <LoadStateLines rows={1} height={48} />
      : variablesState.failed
        ? <p className="live-action-content__status" role="status">{texts.loadFailed[language]}</p>
        : numericVariables?.length === 0
          ? <p className="live-action-content__status" role="status">{texts.noVariables[language]}</p>
          : <Select
            label={texts.variableLabel[language]}
            name="variableName"
            value={selectedName}
            onChange={(name) => {
              if (name === null) return;
              setSelectionState({ channelId, name });
              rememberLastCounterVariable(channelId, name);
            }}
            options={(numericVariables ?? []).map((variable) => ({
              value: variable.name,
              label: variable.name,
              description: `${String(variable.value)}${variable.description.length === 0 ? "" : ` · ${variable.description}`}`,
            }))}
            placeholder={texts.selectVariable[language]}
            disabled={numericVariables?.length === 0}
            required
          />}
  </div>;
}
