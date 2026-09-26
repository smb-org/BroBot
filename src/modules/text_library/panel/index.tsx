import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";

import type { ModulePanelProperties } from "../../contract";
import { TEXT_BLOCK_MAXIMUMS } from "../contracts";
import type { TextBlock, TextBlockCategory, TextBlockConditions, TextBlockVariant, TwitchGame } from "../contracts";
import { firstMatchingTextBlockVariant, validTextBlockConditions, validTextBlockName, validTimeZone } from "../domain";
import { PanelApiError } from "../../../contracts/panel-error";
import { Button, ChatPreview, Field, GamePicker, Select, TextArea } from "../../../dashboard/ui";
import { SYSTEM_TEMPLATE_VARIABLE_LIST } from "../../contract";
import { textLibraryTexts } from "./locale";
import {
  createTextBlock,
  createTextCategory,
  deleteTextBlock,
  deleteTextCategory,
  loadTextLibrary,
  renameTextCategory,
  searchTextLibraryGames,
  saveTextBlock,
  saveTextLibraryTimeZone,
} from "./service";

interface DraftBlock {
  name: string;
  categoryId: string;
  games: TwitchGame[];
  variants: TextBlockVariant[];
}

const newVariant = (isDefault = false): TextBlockVariant => ({
  id: crypto.randomUUID(),
  conditions: isDefault ? {} : { stream: "online" },
  texts: [""],
});

const newDraft = (categoryId: string): DraftBlock => ({
  name: "",
  categoryId,
  games: [],
  variants: [newVariant(true)],
});

const draftFromBlock = (block: TextBlock): DraftBlock => ({
  name: block.name,
  categoryId: block.categoryId,
  games: [...block.games],
  variants: block.variants.map((variant) => ({ ...variant, conditions: { ...variant.conditions }, texts: [...variant.texts] })),
});

const categoryLabel = (category: TextBlockCategory, labels: ReturnType<typeof textLibraryTexts>): string =>
  category.customName ?? (category.catalogKey === null ? category.id : labels.categoryLabels[category.catalogKey]);

const formatEstimate = (text: string, blockNames: ReadonlySet<string>): number => {
  let length = text.length;
  for (const match of text.matchAll(/\{([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?)\}/gu)) {
    const name = match[1];
    if (name === undefined) continue;
    const replacementLength = blockNames.has(name) ? TEXT_BLOCK_MAXIMUMS.renderedLength
      : SYSTEM_TEMPLATE_VARIABLE_LIST.find((variable) => variable.name === name)?.maxLength ?? match[0].length;
    length += replacementLength - match[0].length;
  }
  return length;
};

const errorCode = (error: unknown): string | null => error instanceof PanelApiError ? error.code : null;

const errorPath = (error: unknown): string[] => {
  if (!(error instanceof PanelApiError) || typeof error.details !== "object" || error.details === null || !("path" in error.details) || !Array.isArray(error.details.path)) return [];
  return error.details.path.filter((part): part is string => typeof part === "string");
};

const conditionSummary = (variant: TextBlockVariant, labels: ReturnType<typeof textLibraryTexts>): string => {
  const conditions = variant.conditions;
  if (Object.keys(conditions).length === 0) return labels.defaultVariant;
  const values: string[] = [];
  if (conditions.stream !== undefined) values.push(conditions.stream === "online" ? labels.online : labels.offline);
  if (conditions.game !== undefined) values.push(`${labels.gameCondition} ${conditions.game.mode === "is" ? labels.gameIs : labels.gameIsNot} ${conditions.game.game.name}`);
  if (conditions.minimumTier !== undefined) values.push(`${labels.minimumTier}: ${labels.tierLabels[conditions.minimumTier] ?? conditions.minimumTier}`);
  if (conditions.weekdays !== undefined) values.push(conditions.weekdays.map((day) => labels.weekdaysLabels[day] ?? "").filter(Boolean).join(", "));
  if (conditions.timeWindow !== undefined) values.push(`${conditions.timeWindow.start}–${conditions.timeWindow.end}`);
  return values.length === 0 ? labels.conditions : values.join(" · ");
};

const withoutCondition = (conditions: TextBlockConditions, key: keyof TextBlockConditions): TextBlockConditions => {
  const next = { ...conditions };
  Reflect.deleteProperty(next, key);
  return next;
};

const updateVariant = (variants: TextBlockVariant[], id: string, update: (variant: TextBlockVariant) => TextBlockVariant): TextBlockVariant[] =>
  variants.map((variant) => variant.id === id ? update(variant) : variant);

export default function TextLibraryPanel({ channelId, language, canManage = true }: ModulePanelProperties): ReactElement {
  const labels = useMemo(() => textLibraryTexts(language), [language]);
  const searchGames = useCallback((query: string) => searchTextLibraryGames(channelId, query), [channelId]);
  const [data, setData] = useState<Awaited<ReturnType<typeof loadTextLibrary>> | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftBlock | null>(null);
  const [revision, setRevision] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [gameFilter, setGameFilter] = useState<TwitchGame[]>([]);
  const [simulatedStream, setSimulatedStream] = useState<"online" | "offline">("offline");
  const [simulatedGame, setSimulatedGame] = useState<TwitchGame[]>([]);
  const [simulatedContext, setSimulatedContext] = useState<"command" | "event">("event");
  const [simulatedTier, setSimulatedTier] = useState("everyone");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [showCategories, setShowCategories] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [timezoneDraft, setTimezoneDraft] = useState("");
  const [categoryDrafts, setCategoryDrafts] = useState<Record<string, string>>({});
  const [previewNow, setPreviewNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setPreviewNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const refresh = useCallback(async (select?: string): Promise<void> => {
    const next = await loadTextLibrary(channelId);
    setData(next);
    setTimezoneDraft(next.settings.timeZone);
    if (select !== undefined) {
      const selected = next.blocks.find((block) => block.name === select);
      if (selected !== undefined) {
        setSelectedName(selected.name);
        setDraft(draftFromBlock(selected));
        setRevision(selected.revision);
      }
    } else if (selectedName !== null) {
      const selected = next.blocks.find((block) => block.name === selectedName);
      if (selected === undefined) {
        setSelectedName(null);
        setDraft(null);
        setRevision(null);
      } else {
        setDraft(draftFromBlock(selected));
        setRevision(selected.revision);
      }
    }
  }, [channelId, selectedName]);

  useEffect(() => {
    let active = true;
    loadTextLibrary(channelId).then((next) => {
      if (!active) return;
      setData(next);
      setTimezoneDraft(next.settings.timeZone);
    }).catch(() => { if (active) setError(labels.loadError); });
    return () => { active = false; };
  }, [channelId, labels.loadError]);

  const blockByName = useMemo(() => new Map((data?.blocks ?? []).map((block) => [block.name, block])), [data]);
  const visibleBlocks = useMemo(() => (data?.blocks ?? []).filter((block) => {
    const category = data?.categories.find((entry) => entry.id === block.categoryId);
    const categoryText = category === undefined ? "" : categoryLabel(category, labels);
    const query = search.trim().toLocaleLowerCase();
    const matchesSearch = query.length === 0 || block.name.includes(query) || categoryText.toLocaleLowerCase().includes(query) ||
      block.variants.some((variant) => variant.texts.some((text) => text.toLocaleLowerCase().includes(query)));
    const matchesCategory = categoryFilter.length === 0 || block.categoryId === categoryFilter;
    const matchesGame = gameFilter.length === 0 || block.games.length === 0 || block.games.some((game) => gameFilter.some((selected) => selected.id === game.id));
    return matchesSearch && matchesCategory && matchesGame;
  }), [categoryFilter, data, gameFilter, labels, search]);

  const isCreate = revision === null;
  const nameInvalid = draft === null || !validTextBlockName(draft.name);
  const nameTaken = draft !== null && (data?.blocks.some((block) => block.name === draft.name && block.name !== selectedName) ?? false);
  const variantInvalid = draft === null || draft.variants.length === 0 || draft.variants.length > TEXT_BLOCK_MAXIMUMS.variantsPerBlock ||
    draft.variants.filter((variant) => Object.keys(variant.conditions).length === 0).length !== 1 ||
    Object.keys(draft.variants.at(-1)?.conditions ?? {}).length !== 0 ||
    draft.variants.some((variant) => !validTextBlockConditions(variant.conditions) || variant.texts.length === 0 || variant.texts.length > TEXT_BLOCK_MAXIMUMS.textsPerVariant || variant.texts.some((text) => text.trim().length === 0 || text.length > TEXT_BLOCK_MAXIMUMS.textLength));
  const valid = draft !== null && !nameInvalid && !nameTaken && !variantInvalid && draft.categoryId.length > 0;
  const blockNames = new Set(data?.blocks.map((block) => block.name) ?? []);
  const simulatedGameId = simulatedGame[0]?.id ?? null;
  const blockUnavailableForGame = draft !== null && draft.games.length > 0 &&
    (simulatedGameId === null || !draft.games.some((game) => game.id === simulatedGameId));
  const matchingVariant = draft === null || data === null || blockUnavailableForGame ? null : firstMatchingTextBlockVariant(draft.variants, {
    streamState: simulatedStream,
    game: simulatedGame[0] ?? null,
    chatStatus: simulatedContext === "command" ? [simulatedTier as "viewer" | "subscriber" | "vip" | "moderator" | "broadcaster"] : null,
    commandContext: simulatedContext === "command",
    timeZone: data.settings.timeZone,
    now: previewNow,
  });
  const previewText = matchingVariant?.texts[0] ?? "";
  const previewLength = matchingVariant === null ? 0 : Math.max(...matchingVariant.texts.map((text) => formatEstimate(text, blockNames)));
  const previewTooLong = previewLength > TEXT_BLOCK_MAXIMUMS.renderedLength;
  const nestedVariants = (name: string, visited = new Set<string>()): TextBlockVariant[] => {
    if (visited.has(name)) return [];
    visited.add(name);
    const variants = draft !== null && name === draft.name ? draft.variants : blockByName.get(name)?.variants ?? [];
    const nestedNames = [...new Set(variants.flatMap((variant) => variant.texts.flatMap((text) => [...text.matchAll(/\{([a-z0-9_]{1,32})\}/gu)].flatMap((match) => match[1] === undefined ? [] : [match[1]]))))];
    return [...variants, ...nestedNames.flatMap((nestedName) => nestedVariants(nestedName, new Set(visited)))];
  };
  const variantsInDraftTree = draft === null ? [] : nestedVariants(draft.name);
  const roleConditionUsedOutsideCommand = draft !== null && variantsInDraftTree.some((variant) => variant.conditions.minimumTier !== undefined) &&
    (data?.usages[draft.name] ?? []).some((usage) => usage.kind !== "command");
  const inputVariableUsedOutsideCommand = draft !== null && variantsInDraftTree.some((variant) => variant.texts.some((text) => /\{(?:args|convert)\}/u.test(text))) &&
    (data?.usages[draft.name] ?? []).some((usage) => usage.kind !== "command");

  const openCreate = (): void => {
    const categoryId = data?.categories[0]?.id ?? "";
    setSelectedName(null);
    setDraft(newDraft(categoryId));
    setRevision(null);
    setError("");
  };

  const selectBlock = (block: TextBlock): void => {
    setSelectedName(block.name);
    setDraft(draftFromBlock(block));
    setRevision(block.revision);
    setError("");
  };

  const saveDraft = async (): Promise<void> => {
    if (draft === null || !valid || !canManage) return;
    setPending(true);
    setError("");
    try {
      const payload = {
        ...draft,
        variants: draft.variants.map((variant, index) => index === draft.variants.length - 1 ? { ...variant, conditions: {} } : variant),
        ...(revision === null ? {} : { expectedRevision: revision }),
      };
      const saved = revision === null
        ? await createTextBlock(channelId, payload)
        : await saveTextBlock(channelId, payload);
      await refresh(saved.name);
    } catch (caught: unknown) {
      const code = errorCode(caught);
      const path = errorPath(caught);
      setError(code === "text_library_reference_cycle" ? labels.cycle(path)
        : code === "text_library_reference_depth_exceeded" ? labels.depth(path)
          : code === null ? labels.saveError : labels.errors[code] ?? (caught instanceof PanelApiError && caught.status === 409 ? labels.conflict : labels.saveError));
    } finally {
      setPending(false);
    }
  };

  const removeBlock = async (): Promise<void> => {
    if (selectedName === null || revision === null || !canManage || !window.confirm(labels.deleteConfirm(selectedName))) return;
    setPending(true);
    try {
      await deleteTextBlock(channelId, selectedName, revision);
      setSelectedName(null);
      setDraft(null);
      setRevision(null);
      await refresh();
    } catch (caught: unknown) {
      setError(errorCode(caught) === "text_library_block_conflict" ? labels.conflict : labels.saveError);
    } finally {
      setPending(false);
    }
  };

  const updateCondition = (id: string, update: (conditions: TextBlockConditions) => TextBlockConditions): void => {
    if (draft === null) return;
    setDraft({ ...draft, variants: updateVariant(draft.variants, id, (variant) => ({ ...variant, conditions: update(variant.conditions) })) });
  };

  const saveCategory = async (category: TextBlockCategory): Promise<void> => {
    const name = categoryDrafts[category.id] ?? categoryLabel(category, labels);
    if (!canManage || name.trim().length === 0) return;
    setPending(true);
    try {
      await renameTextCategory(channelId, category.id, name.trim());
      setCategoryDrafts({});
      await refresh();
    } catch { setError(labels.saveError); } finally { setPending(false); }
  };

  const addCategory = async (): Promise<void> => {
    if (!canManage || newCategoryName.trim().length === 0) return;
    setPending(true);
    try {
      await createTextCategory(channelId, newCategoryName.trim());
      setNewCategoryName("");
      await refresh();
    } catch (caught: unknown) {
      const code = errorCode(caught);
      setError(code === null ? labels.saveError : labels.errors[code] ?? labels.categoryLimit);
    } finally { setPending(false); }
  };

  const removeCategory = async (category: TextBlockCategory): Promise<void> => {
    if (!canManage) return;
    setPending(true);
    try { await deleteTextCategory(channelId, category.id); await refresh(); }
    catch (caught: unknown) { setError(errorCode(caught) === "text_library_category_not_empty" ? labels.categoryDeleteBlocked : labels.saveError); }
    finally { setPending(false); }
  };

  const saveTimeZone = async (): Promise<void> => {
    if (data === null || !validTimeZone(timezoneDraft) || !canManage) {
      setError(labels.timezoneInvalid);
      return;
    }
    setPending(true);
    setError("");
    try { await saveTextLibraryTimeZone(channelId, timezoneDraft, data.settings.revision); await refresh(); }
    catch (caught: unknown) { setError(errorCode(caught) === "text_library_settings_conflict" ? labels.conflict : labels.timezoneInvalid); }
    finally { setPending(false); }
  };

  if (data === null) return <section className="module-stack" aria-label={labels.library}><p className={error ? "form-error" : "loading-line"}>{error || labels.loading}</p></section>;
  const categories = data.categories.map((category) => ({ value: category.id, label: categoryLabel(category, labels) }));
  const categoryBlockCounts = new Map(data.categories.map((category) => [category.id, data.blocks.filter((block) => block.categoryId === category.id).length]));

  return (
    <section className="module-stack text-library" aria-label={labels.library}>
      {!canManage ? <p className="lock-reason lock-reason--with-icon" role="note">{labels.operatorReason}</p> : null}
      {error.length === 0 ? null : <p className="form-error" role="alert">{error}</p>}

      <section className={`config-section inspector-section${draft === null ? "" : " inspector-section--open"}`} aria-label={labels.library}>
        <div className="inspector-section__list">
          <div className="section-heading">
            <h2>{labels.library}</h2>
            {canManage ? <Button icon="add" iconOnly ariaLabel={labels.addBlock} disabled={pending || data.blocks.length >= TEXT_BLOCK_MAXIMUMS.blocksPerChannel} {...(data.blocks.length >= TEXT_BLOCK_MAXIMUMS.blocksPerChannel ? { title: labels.blockLimit(TEXT_BLOCK_MAXIMUMS.blocksPerChannel) } : {})} onClick={openCreate} /> : null}
          </div>
          <div className="text-library__filters">
            <Field label={labels.search} value={search} onChange={setSearch} />
            <Select label={labels.categoryFilter} value={categoryFilter} onChange={(value) => setCategoryFilter(value ?? "")} options={[{ value: "", label: labels.filterAny }, ...categories]} />
            <GamePicker searchGames={searchGames} value={gameFilter} onChange={setGameFilter} messages={{ ...labels.gamePicker, label: labels.gameFilter }} />
          </div>
          <p className="muted">{labels.blockLimit(TEXT_BLOCK_MAXIMUMS.blocksPerChannel)}</p>
          {visibleBlocks.length === 0 ? <p className="empty-state">{labels.empty}</p> : (
            <ul className="text-library__list">
              {visibleBlocks.map((block) => {
                const category = data.categories.find((entry) => entry.id === block.categoryId);
                const usages = data.usages[block.name] ?? [];
                return (
                  <li key={block.name}>
                    <button type="button" className="text-library__row" aria-current={selectedName === block.name ? "true" : undefined} onClick={() => selectBlock(block)}>
                      <span className="text-library__row-main"><strong className="mono">{`{${block.name}}`}</strong><span className="text-library__row-meta">{category === undefined ? block.categoryId : categoryLabel(category, labels)} · {labels.variantsCount(block.variants.length)}</span></span>
                      <span className="text-library__usage-count number" aria-label={labels.uses}>{usages.length}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {draft === null ? null : (
          <section className="sub-inspector text-library__editor" aria-label={isCreate ? labels.addBlock : labels.name}>
            <div className="inspector-section__heading">
              <h2>{isCreate ? labels.addBlock : `${labels.name}: ${draft.name}`}</h2>
              {isCreate ? null : <span className="mono">{`{${draft.name}}`}</span>}
            </div>
            <div className="text-library__editor-body">
              <Field
                label={labels.name}
                hint={labels.nameHint}
                value={draft.name}
                onChange={(name) => setDraft({ ...draft, name: name.toLowerCase().replace(/[^a-z0-9_]/gu, "_").slice(0, 32) })}
                disabled={!isCreate || !canManage || pending}
                {...(draft.name.length > 0 && nameInvalid ? { error: labels.nameInvalid } : nameTaken ? { error: labels.nameExists } : {})}
                mono
              />
              <Select label={labels.category} value={draft.categoryId} onChange={(value) => value !== null && setDraft({ ...draft, categoryId: value })} disabled={!canManage || pending} options={categories} />
              <GamePicker searchGames={searchGames} value={draft.games} onChange={(games) => setDraft({ ...draft, games })} messages={{ ...labels.gamePicker, label: labels.gameBound }} disabled={!canManage || pending} />

              <section className="config-section" aria-label={labels.variants}>
                <div className="section-heading"><h3>{labels.variants}</h3><span className="muted">{labels.variantsCount(draft.variants.length)}</span></div>
                {draft.variants.map((variant, index) => {
                  const isDefault = index === draft.variants.length - 1;
                  const variantPreviewLength = Math.max(...variant.texts.map((text) => formatEstimate(text, blockNames)));
                  return (
                    <article className="text-library__variant" key={variant.id}>
                      <div className="text-library__variant-heading">
                        <strong>{isDefault ? labels.defaultVariant : labels.variant(index + 1)}</strong>
                        <span className="muted">{isDefault ? labels.noConditions : conditionSummary(variant, labels)}</span>
                        {!canManage || isDefault ? null : <div className="form-actions">
                          <Button size="compact" disabled={pending || index === 0} onClick={() => setDraft({ ...draft, variants: draft.variants.map((entry, entryIndex, all) => entryIndex === index - 1 ? all[index] as TextBlockVariant : entryIndex === index ? all[index - 1] as TextBlockVariant : entry) })}>{labels.moveUp}</Button>
                          <Button size="compact" disabled={pending || index >= draft.variants.length - 2} onClick={() => setDraft({ ...draft, variants: draft.variants.map((entry, entryIndex, all) => entryIndex === index + 1 ? all[index] as TextBlockVariant : entryIndex === index ? all[index + 1] as TextBlockVariant : entry) })}>{labels.moveDown}</Button>
                          <Button size="compact" danger="subtle" disabled={pending} onClick={() => setDraft({ ...draft, variants: draft.variants.filter((entry) => entry.id !== variant.id) })}>{labels.removeVariant}</Button>
                        </div>}
                      </div>
                      {isDefault ? null : <fieldset className="text-library__conditions" disabled={!canManage || pending}>
                        <legend>{labels.conditions}</legend>
                        <div className="text-library__condition-grid">
                          <Select label={labels.stream} value={variant.conditions.stream ?? "any"} onChange={(value) => updateCondition(variant.id, (conditions) => value === "any" ? withoutCondition(conditions, "stream") : { ...conditions, stream: value as "online" | "offline" })} options={[{ value: "any", label: labels.anyStream }, { value: "online", label: labels.online }, { value: "offline", label: labels.offline }]} />
                          <Select label={labels.minimumTier} value={variant.conditions.minimumTier ?? "none"} onChange={(value) => updateCondition(variant.id, (conditions) => value === "none" ? withoutCondition(conditions, "minimumTier") : { ...conditions, minimumTier: value as NonNullable<TextBlockConditions["minimumTier"]> })} options={[{ value: "none", label: labels.noMinimumTier }, ...Object.entries(labels.tierLabels).map(([value, label]) => ({ value, label }))]} />
                          <Select label={labels.gameCondition} value={variant.conditions.game?.mode ?? ""} onChange={(value) => updateCondition(variant.id, (conditions) => value === "" ? withoutCondition(conditions, "game") : { ...conditions, game: { mode: value as "is" | "is_not", game: conditions.game?.game ?? { id: "", name: "" } } })} options={[{ value: "", label: labels.anyStream }, { value: "is", label: labels.gameIs }, { value: "is_not", label: labels.gameIsNot }]} />
                          <GamePicker
                            searchGames={searchGames}
                            value={variant.conditions.game === undefined || variant.conditions.game.game.id.length === 0 ? [] : [variant.conditions.game.game]}
                            onChange={(games) => updateCondition(variant.id, (conditions) => games[0] === undefined ? withoutCondition(conditions, "game") : { ...conditions, game: { mode: conditions.game?.mode ?? "is", game: games[0] } })}
                            messages={{ ...labels.gamePicker, label: labels.gameCondition }}
                            disabled={!canManage || pending}
                          />
                        </div>
                        {variant.conditions.game?.game.id.length === 0 ? <p className="form-error">{labels.gamePicker.hint}</p> : null}
                        <div className="text-library__weekdays" role="group" aria-label={labels.weekdays}>
                          {labels.weekdaysLabels.map((day, dayIndex) => {
                            const selected = variant.conditions.weekdays?.includes(dayIndex) ?? false;
                            return <Button key={day} size="compact" ariaPressed={selected} disabled={!canManage || pending} onClick={() => updateCondition(variant.id, (conditions) => {
                              const selectedDays = new Set(conditions.weekdays ?? []);
                              if (selected) selectedDays.delete(dayIndex); else selectedDays.add(dayIndex);
                              return selectedDays.size === 0 ? withoutCondition(conditions, "weekdays") : { ...conditions, weekdays: [...selectedDays].sort((left, right) => left - right) };
                            })}>{day}</Button>;
                          })}
                        </div>
                        <div className="text-library__time-window">
                          <span>{labels.timeWindow}</span>
                          <Field label={labels.startTime} value={variant.conditions.timeWindow?.start ?? "00:00"} disabled={!canManage || pending} onChange={(start) => updateCondition(variant.id, (conditions) => ({ ...conditions, timeWindow: { start, end: conditions.timeWindow?.end ?? "23:59" } }))} />
                          <Field label={labels.endTime} value={variant.conditions.timeWindow?.end ?? "23:59"} disabled={!canManage || pending} onChange={(end) => updateCondition(variant.id, (conditions) => ({ ...conditions, timeWindow: { start: conditions.timeWindow?.start ?? "00:00", end } }))} />
                          {variant.conditions.timeWindow === undefined ? <Button size="compact" disabled={!canManage || pending} onClick={() => updateCondition(variant.id, (conditions) => ({ ...conditions, timeWindow: { start: "00:00", end: "23:59" } }))}>{labels.timeWindow}</Button> : null}
                          {variant.conditions.timeWindow === undefined ? null : <Button size="compact" disabled={!canManage || pending} onClick={() => updateCondition(variant.id, (conditions) => withoutCondition(conditions, "timeWindow"))}>{labels.removeTimeWindow}</Button>}
                        </div>
                      </fieldset>}
                      <div className="text-library__texts">
                        {variant.texts.map((text, textIndex) => (
                          <div className="text-library__text-field" key={`${variant.id}-${String(textIndex)}`}>
                            <TextArea label={`${labels.text}${variant.texts.length > 1 ? ` ${String(textIndex + 1)}` : ""}`} hint={labels.textHint} value={text} onChange={(value) => setDraft({ ...draft, variants: updateVariant(draft.variants, variant.id, (entry) => ({ ...entry, texts: entry.texts.map((current, currentIndex) => currentIndex === textIndex ? value : current) })) })} maxLength={TEXT_BLOCK_MAXIMUMS.textLength} disabled={!canManage || pending} variables={[
                              ...SYSTEM_TEMPLATE_VARIABLE_LIST.flatMap((variable) => variable.group === undefined ? [] : [{ name: variable.name, description: variable.name, sample: variable.sample, group: variable.group, kind: "system" as const, ...(variable.external === undefined ? {} : { external: variable.external }), ...(variable.parameters === undefined ? {} : { parameters: variable.parameters }) }]),
                              ...data.blocks.map((block) => ({ name: block.name, description: `Text block {${block.name}}`, sample: block.variants.flatMap((entry) => entry.texts)[0] ?? "", group: "channel" as const })),
                            ]} messages={{
                              countLabel: (count, maximum) => `${String(count)} / ${String(maximum)}`,
                              previewCountLabel: (count) => String(count),
                              unknownVariable: (name, suggestion) => suggestion === null ? `{${name}}` : `{${name}} → {${suggestion}}`,
                              insertSuggestionLabel: (name) => `{${name}} einsetzen`,
                              worstCaseLength: (length, maximum) => `${String(length)} / ${String(maximum)}`,
                            }} />
                            {variant.texts.length <= 1 || !canManage ? null : <Button size="compact" danger="subtle" disabled={pending} onClick={() => setDraft({ ...draft, variants: updateVariant(draft.variants, variant.id, (entry) => ({ ...entry, texts: entry.texts.filter((_entry, entryIndex) => entryIndex !== textIndex) })) })}>{labels.removeText}</Button>}
                          </div>
                        ))}
                        {variant.texts.length >= TEXT_BLOCK_MAXIMUMS.textsPerVariant || !canManage ? null : <Button size="compact" disabled={pending} onClick={() => setDraft({ ...draft, variants: updateVariant(draft.variants, variant.id, (entry) => ({ ...entry, texts: [...entry.texts, ""] })) })}>{labels.addText}</Button>}
                      </div>
                      {variantPreviewLength > TEXT_BLOCK_MAXIMUMS.renderedLength ? <p className="text-library__warning" role="note">{labels.previewTooLong(variantPreviewLength)}</p> : null}
                    </article>
                  );
                })}
                {draft.variants.length >= TEXT_BLOCK_MAXIMUMS.variantsPerBlock || !canManage ? null : <Button disabled={pending} onClick={() => setDraft({ ...draft, variants: [...draft.variants.slice(0, -1), newVariant(), draft.variants[draft.variants.length - 1] as TextBlockVariant] })}>{labels.addVariant}</Button>}
              </section>

              <section className="config-section text-library__preview" aria-label={labels.preview}>
                <div className="section-heading"><h3>{labels.preview}</h3></div>
                <div className="text-library__condition-grid">
                  <Select label={labels.simulateStream} value={simulatedStream} onChange={(value) => value !== null && setSimulatedStream(value as "online" | "offline")} options={[{ value: "online", label: labels.online }, { value: "offline", label: labels.offline }]} />
                  <Select label={labels.simulateContext} value={simulatedContext} onChange={(value) => value !== null && setSimulatedContext(value as "command" | "event")} options={[{ value: "command", label: labels.commandContext }, { value: "event", label: labels.eventContext }]} />
                  {simulatedContext === "command" ? <Select label={labels.minimumTier} value={simulatedTier} onChange={(value) => value !== null && setSimulatedTier(value)} options={Object.entries(labels.tierLabels).map(([value, label]) => ({ value, label }))} /> : null}
                  <GamePicker searchGames={searchGames} value={simulatedGame} onChange={(games) => setSimulatedGame(games.slice(0, 1))} messages={{ ...labels.gamePicker, label: labels.gameCondition }} />
                </div>
                {matchingVariant === null ? <p className="muted">{blockUnavailableForGame ? labels.blockUnavailableForGame : labels.noMatchingVariant}</p> : <>
                  <p className="muted">{labels.selectedVariant(isDefaultVariant(matchingVariant, draft) ? labels.defaultVariant : labels.variant(draft.variants.findIndex((variant) => variant.id === matchingVariant.id) + 1))}</p>
                  <div className="text-library__preview-output"><ChatPreview label={labels.preview} text={previewText} speaker="Bot" countLabel={String(previewText.length)} /></div>
                  {previewTooLong ? <p className="text-library__warning" role="note">{labels.previewTooLong(previewLength)}</p> : null}
                </>}
                {roleConditionUsedOutsideCommand ? <p className="text-library__warning" role="note">{labels.roleConditionHint}</p> : null}
                {inputVariableUsedOutsideCommand ? <p className="text-library__warning" role="note">{labels.argsContextWarning}</p> : null}
              </section>

              <section className="config-section" aria-label={labels.uses}>
                <div className="section-heading"><h3>{labels.uses}</h3></div>
                {(data.usages[draft.name] ?? []).length === 0 ? <p className="muted">{labels.noUsages}</p> : <ul className="text-library__usages">{(data.usages[draft.name] ?? []).map((usage, index) => <li key={`${usage.kind}-${usage.label}-${String(index)}`}><span>{labels.usageKind[usage.kind]}</span><span>{usage.label}</span></li>)}</ul>}
              </section>

              <div className="form-actions">
                {canManage ? <Button variant="primary" disabled={pending || !valid} onClick={() => { void saveDraft(); }}>{isCreate ? labels.create : labels.save}</Button> : null}
                {canManage && !isCreate ? <Button danger="subtle" disabled={pending} onClick={() => { void removeBlock(); }}>{labels.delete}</Button> : null}
                <Button disabled={pending} onClick={() => { setDraft(null); setSelectedName(null); setRevision(null); setError(""); }}>{labels.discard}</Button>
              </div>
              {isCreate && data.blocks.length >= TEXT_BLOCK_MAXIMUMS.blocksPerChannel ? <p className="form-error">{labels.blockLimit(TEXT_BLOCK_MAXIMUMS.blocksPerChannel)}</p> : null}
            </div>
          </section>
        )}
      </section>

      <details className="text-library__settings" open={showCategories} onToggle={(event) => setShowCategories(event.currentTarget.open)}>
        <summary>{labels.categories}</summary>
        <div className="text-library__settings-body">
          {data.categories.map((category) => {
            const originalName = categoryLabel(category, labels);
            const value = categoryDrafts[category.id] ?? category.customName ?? originalName;
            const isEmpty = categoryBlockCounts.get(category.id) === 0;
            return <div className="text-library__category-row" key={category.id}>
              <Field label={`${labels.categoryName}: ${originalName}`} value={value} onChange={(name) => setCategoryDrafts({ ...categoryDrafts, [category.id]: name })} disabled={!canManage || pending || category.catalogKey !== null} maxLength={40} countLabel={(count, maximum) => `${String(count)} / ${String(maximum)}`} />
              {canManage && category.catalogKey === null ? <>
                <Button size="compact" disabled={pending || value.trim().length === 0 || value === originalName} onClick={() => { void saveCategory(category); }}>{labels.categoryRename}</Button>
                <Button size="compact" danger="subtle" disabled={pending || !isEmpty} {...(isEmpty ? {} : { title: labels.categoryDeleteBlocked })} onClick={() => { void removeCategory(category); }}>{labels.categoryDelete}</Button>
              </> : null}
              {!isEmpty ? null : <span className="muted">{labels.categoryEmpty}</span>}
              {!isEmpty && !canManage ? <span className="muted">{labels.categoryDeleteBlocked}</span> : null}
            </div>;
          })}
          {canManage ? <div className="text-library__category-create">
            <Field label={labels.categoryName} value={newCategoryName} onChange={setNewCategoryName} maxLength={40} countLabel={(count, maximum) => `${String(count)} / ${String(maximum)}`} disabled={pending} />
            <Button disabled={pending || newCategoryName.trim().length === 0 || data.categories.length >= 25} onClick={() => { void addCategory(); }}>{labels.categoryAdd}</Button>
            {data.categories.length >= 25 ? <p className="muted">{labels.categoryLimit}</p> : null}
          </div> : null}
          <div className="text-library__timezone">
            <Field label={labels.timezone} hint={labels.timezoneHint} value={timezoneDraft} onChange={setTimezoneDraft} disabled={!canManage || pending} {...(timezoneDraft.length > 0 && !validTimeZone(timezoneDraft) ? { error: labels.timezoneInvalid } : {})} />
            {canManage ? <Button disabled={pending || timezoneDraft === data.settings.timeZone || !validTimeZone(timezoneDraft)} onClick={() => { void saveTimeZone(); }}>{labels.save}</Button> : null}
          </div>
        </div>
      </details>
    </section>
  );
}

const isDefaultVariant = (variant: TextBlockVariant, draft: DraftBlock): boolean => draft.variants.at(-1)?.id === variant.id;
