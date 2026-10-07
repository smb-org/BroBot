import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import type { ModulePanelProperties } from "../../contract";
import { TEXT_BLOCK_MAXIMUMS } from "../contracts";
import type { TextBlock, TextBlockCategory, TextBlockConditions, TextBlockVariant, TwitchGame } from "../contracts";
import { firstMatchingTextBlockVariant, validTextBlockConditions, validTextBlockName } from "../domain";
import { PanelApiError } from "../../../contracts/panel-error";
import { Badge, Button, ChatPreview, ConfirmDialog, Field, FilterBar, GamePicker, InspectorActions, InspectorFieldRow, InspectorSection, ListDetail, LoadState, registeredTemplatePickerGroup, registerDashboardNavigationGuard, Select, Skeleton, SubInspector, TextArea, notify, useDraftGuard } from "../../../dashboard/ui";
import { templateVariableNames } from "../../contract";
import { systemTemplateVariableLocale } from "../../../dashboard/locale";
import { textLibraryTexts } from "./locale";
import { estimateEmbeddedBlockOverflow } from "./embedded-block-overflow";
import {
  createTextBlock,
  createTextCategory,
  deleteTextBlock,
  deleteTextCategory,
  loadTextLibrary,
  renderTextLibraryPreview,
  renameTextCategory,
  searchTextLibraryGames,
  saveTextBlock,
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

const errorCode = (error: unknown): string | null => error instanceof PanelApiError ? error.code : null;

const errorPath = (error: unknown): string[] => {
  if (!(error instanceof PanelApiError) || typeof error.details !== "object" || error.details === null || !("path" in error.details) || !Array.isArray(error.details.path)) return [];
  return error.details.path.filter((part): part is string => typeof part === "string");
};

const templateContentIssues = (error: unknown, labels: ReturnType<typeof textLibraryTexts>): string[] => {
  if (!(error instanceof PanelApiError) || typeof error.details !== "object" || error.details === null ||
      !("issues" in error.details) || !Array.isArray(error.details.issues)) return [];
  return error.details.issues.flatMap((issue: unknown) => {
    if (typeof issue !== "object" || issue === null) return [];
    const record = issue as Record<string, unknown>;
    return record.reason === "input_dependent" && typeof record.consumerName === "string"
      ? [labels.templateInputDependent(record.consumerName)]
      : [];
  });
};

const conditionSummary = (
  variant: TextBlockVariant,
  labels: ReturnType<typeof textLibraryTexts>,
  dataConditions: NonNullable<ModulePanelProperties["textBlockConditions"]>,
  language: "de" | "en",
): string => {
  const conditions = variant.conditions;
  if (Object.keys(conditions).length === 0) return labels.defaultVariant;
  const values: string[] = [];
  if (conditions.stream !== undefined) values.push(conditions.stream === "online" ? labels.online : labels.offline);
  if (conditions.game !== undefined) values.push(`${labels.gameCondition} ${conditions.game.mode === "is" ? labels.gameIs : labels.gameIsNot} ${conditions.game.game.name}`);
  if (conditions.minimumTier !== undefined) values.push(`${labels.minimumTier}: ${labels.tierLabels[conditions.minimumTier] ?? conditions.minimumTier}`);
  if (conditions.weekdays !== undefined) values.push(conditions.weekdays.map((day) => labels.weekdaysLabels[day] ?? "").filter(Boolean).join(", "));
  if (conditions.timeWindow !== undefined) values.push(`${conditions.timeWindow.start}–${conditions.timeWindow.end}`);
  for (const [id, selected] of Object.entries(conditions.data ?? {})) {
    const definition = dataConditions.find((condition) => condition.id === id);
    const value = definition?.values[selected];
    if (definition !== undefined && value !== undefined) values.push(`${definition.label[language]}: ${value[language]}`);
  }
  return values.length === 0 ? labels.conditions : values.join(" · ");
};

const withoutCondition = (conditions: TextBlockConditions, key: keyof TextBlockConditions): TextBlockConditions => {
  const next = { ...conditions };
  Reflect.deleteProperty(next, key);
  return next;
};

const withDataCondition = (conditions: TextBlockConditions, id: string, value: string): TextBlockConditions => {
  const data = { ...conditions.data };
  if (value.length === 0) Reflect.deleteProperty(data, id);
  else data[id] = value;
  return Object.keys(data).length === 0 ? withoutCondition(conditions, "data") : { ...conditions, data };
};

const updateVariant = (variants: TextBlockVariant[], id: string, update: (variant: TextBlockVariant) => TextBlockVariant): TextBlockVariant[] =>
  variants.map((variant) => variant.id === id ? update(variant) : variant);

export default function TextLibraryPanel({ channelId, language, canManage = true, textBlockConditions = [] }: ModulePanelProperties): ReactElement {
  const labels = useMemo(() => textLibraryTexts(language), [language]);
  const resolvedLanguage = language === "en" ? "en" : "de";
  const searchGames = useCallback((query: string) => searchTextLibraryGames(channelId, query), [channelId]);
  const [data, setData] = useState<Awaited<ReturnType<typeof loadTextLibrary>> | null>(null);
  const conditionDefinitions = data?.dataConditionDefinitions ?? textBlockConditions;
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftBlock | null>(null);
  const [baselineDraft, setBaselineDraft] = useState<DraftBlock | null>(null);
  const [revision, setRevision] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [gameFilter, setGameFilter] = useState<TwitchGame[]>([]);
  const [simulatedStream, setSimulatedStream] = useState<"online" | "offline">("offline");
  const [simulatedGame, setSimulatedGame] = useState<TwitchGame[]>([]);
  const [simulatedContext, setSimulatedContext] = useState<"command" | "event">("event");
  const [simulatedTier, setSimulatedTier] = useState("everyone");
  const [pending, setPending] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [categoryDrafts, setCategoryDrafts] = useState<Record<string, string>>({});
  const [previewNow, setPreviewNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setPreviewNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const refresh = useCallback(async (select?: string): Promise<void> => {
    const next = await loadTextLibrary(channelId);
    setData(next);
    setLoadFailed(false);
    if (select !== undefined) {
      const selected = next.blocks.find((block) => block.name === select);
      if (selected !== undefined) {
        setSelectedName(selected.name);
        setDraft(draftFromBlock(selected));
        setBaselineDraft(draftFromBlock(selected));
        setRevision(selected.revision);
      }
    } else if (selectedName !== null) {
      const selected = next.blocks.find((block) => block.name === selectedName);
      if (selected === undefined) {
        setSelectedName(null);
        setDraft(null);
        setBaselineDraft(null);
        setRevision(null);
      } else {
        setDraft(draftFromBlock(selected));
        setBaselineDraft(draftFromBlock(selected));
        setRevision(selected.revision);
      }
    }
  }, [channelId, selectedName]);

  useEffect(() => {
    let active = true;
    loadTextLibrary(channelId).then((next) => {
      if (!active) return;
      setData(next);
      setLoadFailed(false);
    }).catch(() => { if (active) { setLoadFailed(true); notify({ tone: "error", message: labels.loadError }); } });
    return () => { active = false; };
  }, [channelId, labels.loadError]);

  const blockByName = useMemo(() => new Map((data?.blocks ?? []).map((block) => [block.name, block])), [data]);
  const reservedNames = new Set(data?.reservedNames ?? []);
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
  const nameReserved = draft !== null && (data?.reservedNames?.includes(draft.name) ?? false);
  const variantInvalid = draft === null || draft.variants.length === 0 || draft.variants.length > TEXT_BLOCK_MAXIMUMS.variantsPerBlock ||
    draft.variants.filter((variant) => Object.keys(variant.conditions).length === 0).length !== 1 ||
    Object.keys(draft.variants.at(-1)?.conditions ?? {}).length !== 0 ||
    draft.variants.some((variant) => !validTextBlockConditions(variant.conditions) || variant.texts.length === 0 || variant.texts.length > TEXT_BLOCK_MAXIMUMS.textsPerVariant || variant.texts.some((text) => text.trim().length === 0 || text.length > TEXT_BLOCK_MAXIMUMS.textLength));
  const valid = draft !== null && !nameInvalid && !nameTaken && !nameReserved && !variantInvalid && draft.categoryId.length > 0;
  const dirty = draft !== null && baselineDraft !== null && JSON.stringify(draft) !== JSON.stringify(baselineDraft);
  const blockVariants = new Map((data?.blocks ?? [])
    .filter((block) => !reservedNames.has(block.name))
    .map((block) => [block.name, block.variants]));
  if (draft !== null && draft.name.length > 0 && !reservedNames.has(draft.name)) blockVariants.set(draft.name, draft.variants);
  const simulatedGameId = simulatedGame[0]?.id ?? null;
  const blockUnavailableForGame = draft !== null && draft.games.length > 0 &&
    (simulatedGameId === null || !draft.games.some((game) => game.id === simulatedGameId));
  const matchingVariant = draft === null || data === null || blockUnavailableForGame ? null : firstMatchingTextBlockVariant(draft.variants, {
    streamState: simulatedStream,
    game: simulatedGame[0] ?? null,
    chatStatus: simulatedContext === "command"
      ? [simulatedTier === "everyone" ? "viewer" : simulatedTier as "subscriber" | "vip" | "moderator" | "broadcaster"]
      : null,
    commandContext: simulatedContext === "command",
    timeZone: data.channelSettings.timeZone,
    now: previewNow,
    ...(data.dataConditionValues === undefined ? {} : { dataConditions: data.dataConditionValues }),
  });
  const previewTemplate = matchingVariant?.texts[0] ?? "";
  const [previewResult, setPreviewResult] = useState<string | null>(null);
  const [debouncedPreviewTemplate, setDebouncedPreviewTemplate] = useState(previewTemplate);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedPreviewTemplate(previewTemplate), 300);
    return () => window.clearTimeout(timer);
  }, [previewTemplate]);
  // requestId identifies the in-flight request so a late response from a superseded
  // request (older template or simulation inputs) is ignored instead of overwriting
  // the preview for whatever is current now.
  const previewRequestId = useRef(0);
  useEffect(() => {
    if (data === null || debouncedPreviewTemplate.length === 0) return;
    const requestId = ++previewRequestId.current;
    const chatStatus: ("viewer" | "subscriber" | "vip" | "moderator" | "broadcaster")[] | null = simulatedContext === "command"
      ? [simulatedTier === "everyone" ? "viewer" : simulatedTier as "subscriber" | "vip" | "moderator" | "broadcaster"]
      : null;
    renderTextLibraryPreview(channelId, {
      text: debouncedPreviewTemplate,
      templateContext: simulatedContext === "command" ? "chat_command" : "event",
      streamState: simulatedStream,
      game: simulatedGame[0] ?? null,
      chatStatus,
    }).then((result) => {
      if (previewRequestId.current === requestId) setPreviewResult(result.text);
    }).catch(() => {
      // Only the latest request clears a stale result; a superseded request failing
      // must not blank out a still-current, already-rendered preview.
      if (previewRequestId.current === requestId) setPreviewResult(null);
    });
  }, [channelId, data, debouncedPreviewTemplate, previewNow, simulatedContext, simulatedGame, simulatedStream, simulatedTier]);
  const previewText = previewTemplate.length === 0 ? "" : previewResult ?? previewTemplate;
  const previewOverflow = matchingVariant === null ? null : estimateEmbeddedBlockOverflow(matchingVariant.texts, blockVariants, data?.templateVariables ?? []);
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
  const commandInputVariables = new Set(data?.templateVariables
    .filter((variable) => variable.unavailableContextText !== undefined && !(variable.contexts?.includes("event") ?? true))
    .map((variable) => variable.name) ?? []);
  const inputVariableUsedOutsideCommand = draft !== null && variantsInDraftTree.some((variant) => variant.texts.some((text) =>
    templateVariableNames(text).some((name) => commandInputVariables.has(name)),
  )) &&
    (data?.usages[draft.name] ?? []).some((usage) => usage.kind !== "command");

  const openCreateNow = (): void => {
    const categoryId = data?.categories[0]?.id ?? "";
    const initial = newDraft(categoryId);
    setSelectedName(null);
    setDraft(initial);
    setBaselineDraft(initial);
    setRevision(null);
  };

  const closeEditorNow = (): void => {
    setSelectedName(null);
    setDraft(null);
    setBaselineDraft(null);
    setRevision(null);
  };

  const selectBlockNow = (block: TextBlock): void => {
    setSelectedName(block.name);
    setDraft(draftFromBlock(block));
    setBaselineDraft(draftFromBlock(block));
    setRevision(block.revision);
  };

  const saveDraft = async (): Promise<string | null> => {
    if (draft === null || !valid || !canManage) return labels.saveError;
    setPending(true);
    try {
      const payload = {
        ...draft,
        variants: draft.variants.map((variant, index) => index === draft.variants.length - 1 ? { ...variant, conditions: {} } : variant),
      };
      const saved = revision === null
        ? await createTextBlock(channelId, payload)
        : await saveTextBlock(channelId, { ...payload, revision });
      await refresh(saved.name);
      return null;
    } catch (caught: unknown) {
      const code = errorCode(caught);
      const path = errorPath(caught);
      const contentIssues = templateContentIssues(caught, labels);
      const message = code === "text_library_reference_cycle" ? labels.cycle(path)
        : code === "text_library_reference_depth_exceeded" ? labels.depth(path)
          : code === "text_library_template_usage_invalid" && contentIssues.length > 0 ? contentIssues.join(" ")
            : code === null ? labels.saveError : labels.errors[code] ?? (caught instanceof PanelApiError && caught.status === 409 ? labels.conflict : labels.saveError);
      return message;
    } finally {
      setPending(false);
    }
  };

  const saveDraftWithToast = async (): Promise<void> => {
    const failure = await saveDraft();
    if (failure !== null) notify({ tone: "error", message: failure });
  };

  const discardDraft = useCallback((): void => {
    if (baselineDraft !== null) setDraft({ ...baselineDraft, games: [...baselineDraft.games], variants: baselineDraft.variants.map((variant) => ({ ...variant, conditions: { ...variant.conditions }, texts: [...variant.texts] })) });
  }, [baselineDraft]);
  const draftGuard = useDraftGuard(dirty, saveDraft, discardDraft);
  useEffect(() => registerDashboardNavigationGuard(draftGuard.guardSwitch), [draftGuard.guardSwitch]);
  const openCreate = (): void => { draftGuard.guardSwitch(openCreateNow); };
  const closeEditor = (): void => { draftGuard.guardSwitch(closeEditorNow); };
  const selectBlock = (block: TextBlock): void => { draftGuard.guardSwitch(() => { selectBlockNow(block); }); };

  const removeBlock = async (): Promise<void> => {
    if (selectedName === null || revision === null || !canManage) return;
    setPending(true);
    try {
      await deleteTextBlock(channelId, selectedName, revision);
      setSelectedName(null);
      setDraft(null);
      setBaselineDraft(null);
      setRevision(null);
      setConfirmingDelete(false);
      await refresh();
    } catch (caught: unknown) {
      notify({ tone: "error", message: errorCode(caught) === "text_library_block_conflict" ? labels.conflict : labels.saveError });
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
    } catch { notify({ tone: "error", message: labels.saveError }); } finally { setPending(false); }
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
      notify({ tone: "error", message: code === null ? labels.saveError : labels.errors[code] ?? labels.categoryLimit });
    } finally { setPending(false); }
  };

  const removeCategory = async (category: TextBlockCategory): Promise<void> => {
    if (!canManage) return;
    setPending(true);
    try { await deleteTextCategory(channelId, category.id); await refresh(); }
    catch (caught: unknown) { notify({ tone: "error", message: errorCode(caught) === "text_library_category_not_empty" ? labels.categoryDeleteBlocked : labels.saveError }); }
    finally { setPending(false); }
  };

  if (data === null) return <section className="module-stack text-library" aria-label={labels.library}>
    <LoadState status={loadFailed ? "error" : "loading"} minHeight="calc(var(--s10) * 30)"
      loading={<Skeleton rows={8} height={34} />}
      empty={<div />}
      error={<div style={{ minHeight: "calc(var(--s10) * 30)" }} />}
    >{null}</LoadState>
  </section>;
  const categories = data.categories.map((category) => ({ value: category.id, label: categoryLabel(category, labels) }));
  const categoryBlockCounts = new Map(data.categories.map((category) => [category.id, data.blocks.filter((block) => block.categoryId === category.id).length]));
  const activeFilters = [
    ...(search.trim().length === 0 ? [] : [`${labels.search}: ${search.trim()}`]),
    ...(categoryFilter.length === 0 ? [] : [`${labels.categoryFilter}: ${categories.find((category) => category.value === categoryFilter)?.label ?? categoryFilter}`]),
    ...gameFilter.map((game) => `${labels.gameFilter}: ${game.name}`),
  ];
  const previewWarnings = [
    previewOverflow === null ? null : labels.previewTooLong(previewOverflow.blockNames),
    roleConditionUsedOutsideCommand ? labels.roleConditionHint : null,
    inputVariableUsedOutsideCommand ? labels.inputContextWarning : null,
  ].filter((message): message is string => message !== null);
  const atBlockLimit = data.blocks.length >= TEXT_BLOCK_MAXIMUMS.blocksPerChannel;
  const createReason = !canManage ? labels.managementLocked
    : atBlockLimit ? labels.blockLimitReached(data.blocks.length, TEXT_BLOCK_MAXIMUMS.blocksPerChannel) : "";

  return (
    <section className="module-stack text-library" aria-label={labels.library} style={{ minHeight: "calc(var(--s10) * 30)" }}>

      <ListDetail
        list={<section className="config-section text-library__list-panel" aria-label={labels.library}>
          <div className="section-heading">
            <h2>{labels.library}</h2>
            <div className="list-create-action">
              <Button icon="add" iconOnly ariaLabel={labels.addBlock} disabled={pending || createReason.length > 0}
                {...(createReason.length === 0 ? {} : { describedBy: "text-library-create-reason" })} onClick={openCreate} />
              <p id="text-library-create-reason" className="list-create-action__reason" aria-hidden={createReason.length === 0}>{createReason}</p>
            </div>
          </div>
          <FilterBar label={labels.library} className="text-library__filters" summary={activeFilters.length === 0 ? undefined : <div className="form-actions"><p className="muted" aria-live="polite">{labels.activeFilters} {activeFilters.join(" · ")}</p><Button variant="subtle" onClick={() => { setSearch(""); setCategoryFilter(""); setGameFilter([]); }}>{labels.resetFilters}</Button></div>}>
            <Field label={labels.search} placeholder={labels.search} value={search} onChange={setSearch} />
            <Select label={labels.categoryFilter} value={categoryFilter} onChange={(value) => setCategoryFilter(value ?? "")} options={[{ value: "", label: labels.allCategories }, ...categories]} />
            <GamePicker searchGames={searchGames} value={gameFilter} onChange={setGameFilter} messages={{ ...labels.gamePicker, label: labels.gameFilter }} visuallyHiddenLabel />
          </FilterBar>
          <p className="muted">{labels.blockLimit(TEXT_BLOCK_MAXIMUMS.blocksPerChannel)}</p>
          <div data-testid="text-library-list-slot" style={{ height: "calc(var(--s10) * 18)", overflowY: "auto" }}>
          {visibleBlocks.length === 0 ? <p className="empty-state" style={{ minHeight: "calc(var(--s10) * 18)" }}>{labels.empty}</p> : (
            <div className="table-wrap">
              <table className="table table--content text-library__table">
                <thead><tr><th scope="col">{labels.name}</th><th scope="col">{labels.category}</th><th scope="col">{labels.variants}</th><th scope="col">{labels.uses}</th></tr></thead>
                <tbody>{visibleBlocks.map((block) => {
                  const category = data.categories.find((entry) => entry.id === block.categoryId);
                  const usages = data.usages[block.name] ?? [];
                  return <tr key={block.name} aria-selected={selectedName === block.name}>
                    <th scope="row"><button type="button" className="text-library__name-button mono" aria-current={selectedName === block.name ? "true" : undefined} onClick={(event) => { event.currentTarget.focus(); selectBlock(block); }}>{`{${block.name}}`}</button></th>
                    <td>{category === undefined ? block.categoryId : categoryLabel(category, labels)}</td>
                    <td><Badge>{labels.variantsCount(block.variants.length)}</Badge></td>
                    <td><Badge tone={usages.length === 0 ? "neutral" : "brand"}>{labels.usesCount(usages.length)}</Badge></td>
                  </tr>;
                })}</tbody>
              </table>
            </div>
          )}
          </div>
        </section>}
        inspector={draft === null ? null : (

          <SubInspector className="text-library__editor" ariaLabel={isCreate ? labels.addBlock : labels.name} title={isCreate ? labels.addBlock : `${labels.name}: ${draft.name}`} identifier={isCreate ? undefined : draft.name} closeLabel={labels.close} onClose={closeEditor}>
            <div className="text-library__editor-body">
              {canManage ? <>
              <InspectorSection title={labels.generalSection}>
                <InspectorFieldRow label={labels.name} help={labels.nameHint}>
                  <Field
                    label={labels.name}
                    hint={labels.nameHint}
                    value={draft.name}
                    onChange={(name) => setDraft({ ...draft, name: name.toLowerCase().replace(/[^a-z0-9_]/gu, "_").slice(0, 32) })}
                    disabled={!isCreate || pending}
                    {...(draft.name.length > 0 && nameInvalid ? { error: labels.nameInvalid } : nameTaken ? { error: labels.nameExists } : nameReserved ? { error: labels.nameReserved } : {})}
                    mono
                  />
                </InspectorFieldRow>
                <InspectorFieldRow label={labels.category}>
                  <Select label={labels.category} value={draft.categoryId} onChange={(value) => value !== null && setDraft({ ...draft, categoryId: value })} disabled={pending} options={categories} />
                </InspectorFieldRow>
                <InspectorFieldRow label={labels.gameBound} help={labels.gamePicker.hint}>
                  <GamePicker searchGames={searchGames} value={draft.games} onChange={(games) => setDraft({ ...draft, games })} messages={{ ...labels.gamePicker, label: labels.gameBound }} disabled={pending} />
                </InspectorFieldRow>
              </InspectorSection>

              <InspectorSection title={labels.variants} help={labels.variantsCount(draft.variants.length)}>
                {draft.variants.map((variant, index) => {
                  const isDefault = index === draft.variants.length - 1;
                  const variantOverflow = estimateEmbeddedBlockOverflow(variant.texts, blockVariants, data.templateVariables);
                  return (
                    <article className="text-library__variant" key={variant.id}>
                      <div className="text-library__variant-heading">
                        <strong>{isDefault ? labels.defaultVariant : labels.variant(index + 1)}</strong>
                        <span className="muted">{isDefault ? labels.noConditions : conditionSummary(variant, labels, conditionDefinitions, language === "en" ? "en" : "de")}</span>
                        {isDefault ? null : <div className="form-actions">
                          <Button size="compact" disabled={pending || index === 0} onClick={() => setDraft({ ...draft, variants: draft.variants.map((entry, entryIndex, all) => entryIndex === index - 1 ? all[index] as TextBlockVariant : entryIndex === index ? all[index - 1] as TextBlockVariant : entry) })}>{labels.moveUp}</Button>
                          <Button size="compact" disabled={pending || index >= draft.variants.length - 2} onClick={() => setDraft({ ...draft, variants: draft.variants.map((entry, entryIndex, all) => entryIndex === index + 1 ? all[index] as TextBlockVariant : entryIndex === index ? all[index + 1] as TextBlockVariant : entry) })}>{labels.moveDown}</Button>
                          <Button size="compact" danger="subtle" disabled={pending} onClick={() => setDraft({ ...draft, variants: draft.variants.filter((entry) => entry.id !== variant.id) })}>{labels.removeVariant}</Button>
                        </div>}
                      </div>
                      {isDefault ? null : <fieldset className="text-library__conditions" disabled={pending}>
                        <legend>{labels.conditions}</legend>
                        <div className="text-library__condition-grid">
                          <Select label={labels.stream} value={variant.conditions.stream ?? "any"} onChange={(value) => updateCondition(variant.id, (conditions) => value === "any" ? withoutCondition(conditions, "stream") : { ...conditions, stream: value as "online" | "offline" })} options={[{ value: "any", label: labels.anyStream }, { value: "online", label: labels.online }, { value: "offline", label: labels.offline }]} />
                          <Select label={labels.minimumTier} value={variant.conditions.minimumTier ?? "none"} onChange={(value) => updateCondition(variant.id, (conditions) => value === "none" ? withoutCondition(conditions, "minimumTier") : { ...conditions, minimumTier: value as NonNullable<TextBlockConditions["minimumTier"]> })} options={[{ value: "none", label: labels.noMinimumTier }, ...Object.entries(labels.tierLabels).map(([value, label]) => ({ value, label }))]} />
                          {conditionDefinitions.map((condition) => <Select
                            key={condition.id}
                            label={condition.label[language === "en" ? "en" : "de"]}
                            value={variant.conditions.data?.[condition.id] ?? ""}
                            onChange={(value) => updateCondition(variant.id, (conditions) => withDataCondition(conditions, condition.id, value ?? ""))}
                            options={[{ value: "", label: labels.anyCondition }, ...Object.entries(condition.values).map(([value, labelsByLanguage]) => ({ value, label: labelsByLanguage[language === "en" ? "en" : "de"] }))]}
                          />)}
                          <fieldset className="text-library__game-condition">
                            <legend>{labels.gameCondition}</legend>
                            <div className={`text-library__game-match${variant.conditions.game === undefined ? " text-library__game-match--only" : ""}`}>
                              <Select ariaLabel={labels.gameMatch} value={variant.conditions.game?.mode ?? ""} onChange={(value) => updateCondition(variant.id, (conditions) => value === "" ? withoutCondition(conditions, "game") : { ...conditions, game: { mode: value as "is" | "is_not", game: conditions.game?.game ?? { id: "", name: "" } } })} options={[{ value: "", label: labels.anyStream }, { value: "is", label: labels.gameIs }, { value: "is_not", label: labels.gameIsNot }]} />
                            </div>
                            {variant.conditions.game === undefined ? null : <GamePicker
                              searchGames={searchGames}
                              value={variant.conditions.game.game.id.length === 0 ? [] : [variant.conditions.game.game]}
                              onChange={(games) => updateCondition(variant.id, (conditions) => games[0] === undefined ? withoutCondition(conditions, "game") : { ...conditions, game: { mode: conditions.game?.mode ?? "is", game: games[0] } })}
                              messages={{ ...labels.gamePicker, label: labels.gameCondition }}
                              visuallyHiddenLabel
                              disabled={pending}
                            />}
                          </fieldset>
                        </div>
                        <p className="form-error" style={{ minHeight: "var(--s6)", margin: 0 }}>
                          {variant.conditions.game?.game.id.length === 0 ? labels.gamePicker.hint : ""}
                        </p>
                        <div className="text-library__weekdays" role="group" aria-label={labels.weekdays}>
                          {labels.weekdaysLabels.map((day, dayIndex) => {
                            const selected = variant.conditions.weekdays?.includes(dayIndex) ?? false;
                            return <Button key={day} variant={selected ? "primary" : "neutral"} ariaPressed={selected} disabled={pending} onClick={() => updateCondition(variant.id, (conditions) => {
                              const selectedDays = new Set(conditions.weekdays ?? []);
                              if (selected) selectedDays.delete(dayIndex); else selectedDays.add(dayIndex);
                              return selectedDays.size === 0 ? withoutCondition(conditions, "weekdays") : { ...conditions, weekdays: [...selectedDays].sort((left, right) => left - right) };
                            })}>{day}</Button>;
                          })}
                        </div>
                        <div className="text-library__time-window">
                          <span>{labels.timeWindow}</span>
                          {variant.conditions.timeWindow === undefined ? <Button disabled={pending} onClick={() => updateCondition(variant.id, (conditions) => ({ ...conditions, timeWindow: { start: "00:00", end: "23:59" } }))}>{labels.addTimeWindow}</Button> : <>
                            <Field label={labels.startTime} value={variant.conditions.timeWindow.start} disabled={pending} onChange={(start) => updateCondition(variant.id, (conditions) => ({ ...conditions, timeWindow: { start, end: conditions.timeWindow?.end ?? "23:59" } }))} />
                            <Field label={labels.endTime} value={variant.conditions.timeWindow.end} disabled={pending} onChange={(end) => updateCondition(variant.id, (conditions) => ({ ...conditions, timeWindow: { start: conditions.timeWindow?.start ?? "00:00", end } }))} />
                            <Button disabled={pending} onClick={() => updateCondition(variant.id, (conditions) => withoutCondition(conditions, "timeWindow"))}>{labels.removeTimeWindow}</Button>
                          </>}
                        </div>
                      </fieldset>}
                      <div className="text-library__texts">
                        {variant.texts.map((text, textIndex) => (
                          <div className="text-library__text-field" key={`${variant.id}-${String(textIndex)}`}>
                            <TextArea label={`${labels.text}${variant.texts.length > 1 ? ` ${String(textIndex + 1)}` : ""}`} hint={labels.textHint} value={text} onChange={(value) => setDraft({ ...draft, variants: updateVariant(draft.variants, variant.id, (entry) => ({ ...entry, texts: entry.texts.map((current, currentIndex) => currentIndex === textIndex ? value : current) })) })} maxLength={TEXT_BLOCK_MAXIMUMS.textLength} disabled={pending} variables={[
                              ...data.templateVariables.filter((variable) => !data.blocks.some((block) => block.name === variable.name)).flatMap((variable) => {
                                if (variable.group === undefined) return [];
                                const pickerCopy = variable.picker?.[resolvedLanguage];
                                const systemCopy = variable.source === "system"
                                  ? systemTemplateVariableLocale[resolvedLanguage][variable.name as keyof typeof systemTemplateVariableLocale.de]
                                  : undefined;
                                const pickerGroup = registeredTemplatePickerGroup(variable, resolvedLanguage);
                                return [{
                                  name: variable.name,
                                  label: pickerCopy?.label ?? systemCopy?.label ?? variable.name,
                                  description: pickerCopy?.description ?? systemCopy?.description ?? variable.localizedDescription?.[resolvedLanguage] ?? variable.description ?? variable.name,
                                  sample: systemCopy?.sample ?? variable.sample,
                                  ...(pickerCopy?.sample === undefined ? {} : { pickerSample: pickerCopy.sample }),
                                  group: variable.group,
                                  kind: variable.moduleId === "host" ? variable.source === "channel" ? "channel" as const : "system" as const : "module" as const,
                                  ...(pickerGroup === undefined ? {} : { pickerGroup }),
                                  ...(variable.external === undefined ? {} : { external: variable.external }),
                                  ...(variable.parameters === undefined ? {} : { parameters: variable.parameters }),
                                }];
                              }),
                              ...data.blocks.filter((block) => !reservedNames.has(block.name)).map((block) => ({ name: block.name, label: block.name, description: labels.variableDescription(block.name), sample: block.variants.flatMap((entry) => entry.texts)[0] ?? "", group: "channel" as const, isTextBlock: true })),
                            ]} messages={{
                              countLabel: (count, maximum) => `${String(count)} / ${String(maximum)}`,
                              previewCountLabel: (count) => String(count),
                              unknownVariable: (name, suggestion) => suggestion === null ? `{${name}}` : `{${name}} → {${suggestion}}`,
                              insertSuggestionLabel: labels.insertSuggestionLabel,
                              worstCaseLength: (length, maximum) => `${String(length)} / ${String(maximum)}`,
                              variablePicker: labels.variablePicker,
                            }} />
                            {variant.texts.length <= 1 ? null : <Button size="compact" danger="subtle" disabled={pending} onClick={() => setDraft({ ...draft, variants: updateVariant(draft.variants, variant.id, (entry) => ({ ...entry, texts: entry.texts.filter((_entry, entryIndex) => entryIndex !== textIndex) })) })}>{labels.removeText}</Button>}
                          </div>
                        ))}
                        {variant.texts.length >= TEXT_BLOCK_MAXIMUMS.textsPerVariant ? null : <Button size="compact" disabled={pending} onClick={() => setDraft({ ...draft, variants: updateVariant(draft.variants, variant.id, (entry) => ({ ...entry, texts: [...entry.texts, ""] })) })}>{labels.addText}</Button>}
                      </div>
                      <p className="text-library__warning" role={variantOverflow === null ? undefined : "note"} aria-live="polite"
                        style={{ height: "var(--s6)", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", margin: 0 }}
                        title={variantOverflow === null ? undefined : labels.previewTooLong(variantOverflow.blockNames)}>
                        {variantOverflow === null ? "" : labels.previewTooLong(variantOverflow.blockNames)}
                      </p>
                    </article>
                  );
                })}
                {draft.variants.length >= TEXT_BLOCK_MAXIMUMS.variantsPerBlock ? null : <Button disabled={pending} onClick={() => setDraft({ ...draft, variants: [...draft.variants.slice(0, -1), newVariant(), draft.variants[draft.variants.length - 1] as TextBlockVariant] })}>{labels.addVariant}</Button>}
              </InspectorSection>
              </> : <>
                <p className="lock-reason lock-reason--with-icon" role="note">{labels.operatorReason}</p>
                <dl className="text-library__read-only-properties">
                  <div><dt>{labels.name}</dt><dd className="mono">{draft.name}</dd></div>
                  <div><dt>{labels.category}</dt><dd>{categories.find((category) => category.value === draft.categoryId)?.label ?? draft.categoryId}</dd></div>
                  <div><dt>{labels.gameBound}</dt><dd>{draft.games.length === 0 ? labels.filterAny : draft.games.map((game) => game.name).join(", ")}</dd></div>
                  <div>
                    <dt>{labels.variants}</dt>
                    <dd><ol>{draft.variants.map((variant, index) => (
                      <li key={variant.id}>
                        <strong>{index === draft.variants.length - 1 ? labels.defaultVariant : labels.variant(index + 1)}</strong>
                        <p>{conditionSummary(variant, labels, conditionDefinitions, language === "en" ? "en" : "de")}</p>
                        <ul>{variant.texts.map((text, textIndex) => <li key={`${variant.id}-${String(textIndex)}`}><pre>{text}</pre></li>)}</ul>
                      </li>
                    ))}</ol></dd>
                  </div>
                </dl>
              </>}

              <InspectorSection title={labels.preview}>
                <div className="text-library__condition-grid">
                  <Select label={labels.simulateStream} value={simulatedStream} onChange={(value) => value !== null && setSimulatedStream(value as "online" | "offline")} options={[{ value: "online", label: labels.online }, { value: "offline", label: labels.offline }]} />
                  <Select label={labels.simulateContext} value={simulatedContext} onChange={(value) => value !== null && setSimulatedContext(value as "command" | "event")} options={[{ value: "command", label: labels.commandContext }, { value: "event", label: labels.eventContext }]} />
                  {simulatedContext === "command" ? <Select label={labels.minimumTier} value={simulatedTier} onChange={(value) => value !== null && setSimulatedTier(value)} options={Object.entries(labels.tierLabels).map(([value, label]) => ({ value, label }))} /> : null}
                  <GamePicker searchGames={searchGames} value={simulatedGame} onChange={(games) => setSimulatedGame(games.slice(0, 1))} messages={{ ...labels.gamePicker, label: labels.gameCondition }} />
                </div>
                <div data-testid="text-library-preview-slot" style={{ height: "calc(var(--s10) * 9)", overflow: "hidden" }}>
                  {matchingVariant === null ? <p className="muted">{blockUnavailableForGame ? labels.blockUnavailableForGame : labels.noMatchingVariant}</p> : <>
                    <p className="muted" style={{ minHeight: "var(--s6)", margin: 0 }}>{labels.selectedVariant(isDefaultVariant(matchingVariant, draft) ? labels.defaultVariant : labels.variant(draft.variants.findIndex((variant) => variant.id === matchingVariant.id) + 1))}</p>
                    <div className="text-library__preview-output" style={{ height: "calc(var(--s10) * 8)", overflow: "hidden" }}>
                      <ChatPreview label={labels.preview} text={previewText} speaker="Bot" countLabel={String(previewText.length)} />
                    </div>
                  </>}
                </div>
                <p className="text-library__warning" data-testid="text-library-warning-slot" role={previewWarnings.length > 0 ? "note" : undefined} aria-live="polite"
                  style={{ height: "calc(var(--s10) * 3)", overflowY: "auto", margin: 0 }}>
                  {previewWarnings.join(" ")}
                </p>
              </InspectorSection>

              <InspectorSection title={labels.uses}>
                <div data-testid="text-library-usage-slot" style={{ height: "calc(var(--s10) * 7)", overflowY: "auto" }}>
                  {(data.usages[draft.name] ?? []).length === 0 ? <p className="muted">{labels.noUsages}</p> : <ul className="text-library__usages">{(data.usages[draft.name] ?? []).map((usage, index) => <li key={`${usage.kind}-${usage.label}-${String(index)}`}><span>{labels.usageKind[usage.kind]}</span><span>{usage.label}</span></li>)}</ul>}
                </div>
              </InspectorSection>

              <InspectorActions destructive={isCreate ? undefined : <Button danger="subtle" disabled={!canManage || pending} onClick={() => { setConfirmingDelete(true); }}>{labels.delete}</Button>}>
                {canManage ? <Button variant="primary" disabled={pending || !valid || (isCreate && atBlockLimit)} onClick={() => { void saveDraftWithToast(); }}>{isCreate ? labels.create : labels.save}</Button> : null}
                {canManage ? <Button variant="subtle" disabled={pending} onClick={closeEditor}>{labels.discard}</Button> : null}
              </InspectorActions>
              <p className="list-create-action__reason" role={isCreate && atBlockLimit ? "note" : undefined} aria-hidden={!isCreate || !atBlockLimit}>
                {isCreate && atBlockLimit ? labels.blockLimitReached(data.blocks.length, TEXT_BLOCK_MAXIMUMS.blocksPerChannel) : ""}
              </p>
            </div>
          </SubInspector>
        )}
        onCloseInspector={closeEditor}
      />

      <details className="text-library__settings">
        <summary>{labels.categories}</summary>
        <div className="text-library__settings-body">
          {canManage ? <>
          <InspectorSection title={labels.categories}>
          {data.categories.map((category) => {
            const originalName = categoryLabel(category, labels);
            const value = categoryDrafts[category.id] ?? category.customName ?? originalName;
            const isEmpty = categoryBlockCounts.get(category.id) === 0;
            return <div className="text-library__category-row" key={category.id}>
              <Field label={`${labels.categoryName}: ${originalName}`} value={value} onChange={(name) => setCategoryDrafts({ ...categoryDrafts, [category.id]: name })} disabled={pending || category.catalogKey !== null} maxLength={40} countLabel={(count, maximum) => `${String(count)} / ${String(maximum)}`} />
              {category.catalogKey === null ? <>
                <Button size="compact" disabled={pending || value.trim().length === 0 || value === originalName} onClick={() => { void saveCategory(category); }}>{labels.categoryRename}</Button>
                <Button size="compact" danger="subtle" disabled={pending || !isEmpty} {...(isEmpty ? {} : { title: labels.categoryDeleteBlocked })} onClick={() => { void removeCategory(category); }}>{labels.categoryDelete}</Button>
              </> : null}
              {!isEmpty ? null : <span className="muted">{labels.categoryEmpty}</span>}
            </div>;
          })}
          <div className="text-library__category-create">
            <Field label={labels.categoryName} value={newCategoryName} onChange={setNewCategoryName} maxLength={40} countLabel={(count, maximum) => `${String(count)} / ${String(maximum)}`} disabled={pending} />
            <Button disabled={pending || newCategoryName.trim().length === 0 || data.categories.length >= 25} onClick={() => { void addCategory(); }}>{labels.categoryAdd}</Button>
            {data.categories.length >= 25 ? <p className="muted">{labels.categoryLimit}</p> : null}
          </div>
          </InspectorSection>
          </> : <>
            <p className="lock-reason lock-reason--with-icon" role="note">{labels.operatorReason}</p>
            <dl className="text-library__read-only-properties">
              {data.categories.map((category) => <div key={category.id}><dt>{`${labels.categoryName}: ${categoryLabel(category, labels)}`}</dt><dd>{category.customName ?? categoryLabel(category, labels)}</dd></div>)}
            </dl>
          </>}
        </div>
      </details>
      <ConfirmDialog opened={confirmingDelete} title={labels.deleteTitle(selectedName ?? "")} description={labels.deleteConsequence(selectedName ?? "")} confirmLabel={labels.deleteConfirm(selectedName ?? "")} cancelLabel={labels.close} onCancel={() => { setConfirmingDelete(false); }} onConfirm={() => { void removeBlock(); }} pending={pending} danger />
      <ConfirmDialog
        opened={draftGuard.confirmOpen}
        title={labels.draftGuardTitle}
        description={labels.draftGuardDescription}
        confirmLabel={labels.discardAndSwitch}
        cancelLabel={labels.continueEditing}
        onCancel={draftGuard.continueEditing}
        onConfirm={draftGuard.discardAndSwitch}
        {...(valid && canManage ? { alternative: { label: labels.saveAndSwitch, onClick: () => { void draftGuard.saveAndSwitch(); } } } : {})}
        pending={draftGuard.saving}
        {...(draftGuard.saveError === undefined ? {} : { error: draftGuard.saveError })}
        danger
      />
    </section>
  );
}

const isDefaultVariant = (variant: TextBlockVariant, draft: DraftBlock): boolean => draft.variants.at(-1)?.id === variant.id;
