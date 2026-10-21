import { useEffect, useState, type ReactElement } from "react";

import { Button, ChatPreview, Field, SegmentChoice, Select } from "../../../dashboard/ui";
import type { ModuleImmediateActionContentProperties } from "../../contract";
import type { ChatVoteTemplateListState } from "./service";
import { loadChatVoteTemplates } from "./service";
import { chatVotingActionContentTexts } from "./action-content-locale";

type VoteActionMode = "saved" | "ad_hoc";
type VoteActionKind = "yes_no" | "options";

export default function VoteActionContent({ channelId, language, onDraftChange }: ModuleImmediateActionContentProperties): ReactElement {
  const texts = chatVotingActionContentTexts;
  const [templates, setTemplates] = useState<ChatVoteTemplateListState | null>(null);
  const [failed, setFailed] = useState(false);
  const [mode, setMode] = useState<VoteActionMode>("ad_hoc");
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [kind, setKind] = useState<VoteActionKind>("yes_no");
  const [title, setTitle] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [duration, setDuration] = useState("120");
  const cockpitTemplates = templates?.templates.filter((template) => template.offerInCockpit) ?? [];

  useEffect(() => {
    const controller = new AbortController();
    void loadChatVoteTemplates(channelId, controller.signal).then((result) => {
      setTemplates(result);
      setTemplateId(result.templates.find((template) => template.offerInCockpit)?.id ?? null);
    }).catch(() => {
      if (!controller.signal.aborted) setFailed(true);
    });
    return () => { controller.abort(); };
  }, [channelId]);

  const selectedTemplate = templates?.templates.find((template) => template.id === templateId) ?? null;
  const optionLabels = options.map((option) => option.trim());
  const previewTitle = mode === "saved"
    ? selectedTemplate?.title ?? ""
    : title.trim() || texts.previewQuestion[language];
  const previewOptions = mode === "saved"
    ? selectedTemplate?.labels ?? []
    : kind === "yes_no"
      ? [texts.yes[language], texts.no[language]]
      : optionLabels.filter(Boolean);
  const optionText = previewOptions.map((option, index) => `${String(index + 1)}. ${option}`).join(" · ");
  const previewText = `${previewTitle}${optionText.length > 0 ? ` — ${optionText}` : ""}`;

  return <div className="live-action-content live-action-content--vote">
    <div className="live-action-content__template-slot" aria-busy={templates === null && !failed}>
      {templates !== null && cockpitTemplates.length > 0 ? <SegmentChoice
        label={texts.mode[language]}
        value={mode}
        onChange={(value) => { setMode(value); onDraftChange?.(true); }}
        name="mode"
        options={[
          { value: "saved", label: texts.saved[language] },
          { value: "ad_hoc", label: texts.adHoc[language] },
        ]}
      /> : null}
      {templates === null && !failed ? <p className="live-action-content__status" role="status">{texts.loading[language]}</p> : null}
      {failed ? <p className="live-action-content__status" role="status">{texts.savedUnavailable[language]}</p> : null}
      {templates !== null && cockpitTemplates.length === 0 ? <p className="live-action-content__status" role="status">{texts.empty[language]}</p> : null}
    </div>

    {mode === "saved" ? <>
      {templates !== null && cockpitTemplates.length > 0 ? <Select
        label={texts.label[language]}
        value={templateId}
        onChange={setTemplateId}
        name="templateId"
        required
        placeholder={texts.choose[language]}
        options={cockpitTemplates.map((template) => ({ value: template.id, label: template.title }))}
      /> : null}
    </> : <>
      <SegmentChoice
        label={texts.kind[language]}
        value={kind}
        onChange={(value) => { setKind(value); onDraftChange?.(true); }}
        name="kind"
        options={[
          { value: "yes_no", label: texts.yesNo[language] },
          { value: "options", label: texts.multipleChoice[language] },
        ]}
      />
      <Field
        label={texts.title[language]}
        value={title}
        onChange={(value) => { setTitle(value); onDraftChange?.(true); }}
        name="title"
        required
        maxLength={80}
        countLabel={(count, maxLength) => texts.characterCount[language](count, maxLength)}
        placeholder={texts.titlePlaceholder[language]}
      />
      {kind === "options" ? <div className="live-action-content__vote-options">
        <span className="ui-field__label">{texts.options[language]}</span>
        {options.map((option, index) => <div className={`live-action-content__vote-option${options.length > 2 ? " has-remove" : ""}`} key={index}>
          <Field
            label={texts.optionNumber[language](index + 1)}
            labelHidden
            value={option}
            onChange={(value) => { setOptions((current) => current.map((item, itemIndex) => itemIndex === index ? value : item)); onDraftChange?.(true); }}
            name="labels"
            required
            maxLength={32}
            countLabel={(count, maxLength) => texts.characterCount[language](count, maxLength)}
            placeholder={texts.optionPlaceholder[language](index + 1)}
          />
          {options.length > 2 ? <Button
            type="button"
            size="compact"
            variant="secondary"
            ariaLabel={texts.removeOption[language](index + 1)}
            onClick={() => { setOptions((current) => current.filter((_, itemIndex) => itemIndex !== index)); onDraftChange?.(true); }}
          >{texts.remove[language]}</Button> : null}
        </div>)}
        {options.length < 9 ? <Button
          type="button"
          size="compact"
          variant="secondary"
          className="live-action-content__add-option"
          onClick={() => { setOptions((current) => [...current, ""]); onDraftChange?.(true); }}
        >{texts.addOption[language]}</Button> : null}
      </div> : null}
      <Select
        label={texts.duration[language]}
        value={duration}
        onChange={(value) => { if (value !== null) { setDuration(value); onDraftChange?.(true); } }}
        name="durationSeconds"
        required
        options={[
          { value: "60", label: texts.oneMinute[language] },
          { value: "120", label: texts.twoMinutes[language] },
          { value: "300", label: texts.fiveMinutes[language] },
        ]}
      />
    </>}

    <ChatPreview
      label={texts.preview[language]}
      speaker={texts.bot[language]}
      text={previewText}
      countLabel={texts.previewHint[language]}
    />
  </div>;
}
