import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import "./panel.css";

import type { ModulePanelProperties } from "../../contract";
import { TEXT_BLOCK_MAXIMUMS } from "../contracts";
import type { TextBlock, TextBlockCategory, TextBlockConditions, TextBlockUsage, TextBlockVariant, TwitchGame } from "../contracts";
import { firstMatchingTextBlockVariant, validTextBlockConditions, validTextBlockName } from "../domain";
import { blockReferencesInText } from "../../contracts/text-block-references";
import { PanelApiError } from "../../../contracts/panel-error";
import { ActionMenu, Badge, Button, ChatPreview, CollectionPage, ConfirmDialog, Dialog, EmptyState, Field, GameMultiSelect, InspectorFieldRow, ListToolbar, LoadState, LoadStateLines, PageHeader, registeredModuleTemplateGroup, registerDashboardNavigationGuard, RuleNote, Section, Select, TemplateTextField, notify, useDraftGuard, useTemplatePreview } from "../../../dashboard/ui";
import { templateVariableNames } from "../../contract";
import { dashboardCommonTexts, systemTemplateVariableLocale } from "../../../dashboard/locale";
import { refetchModuleQueryData, runModuleQueryWrite, useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
import { templateTextLength } from "../../../contracts/template-text-length";
import { textLibraryTexts } from "./locale";
import { estimateEmbeddedBlockOverflow } from "./embedded-block-overflow";
import {
  createTextBlock,
  createTextCategory,
  deleteTextBlock,
  deleteTextCategory,
  loadTextLibrary,
  lookupTextLibraryGames,
  renderTextLibraryPreview,
  renameTextCategory,
  searchTextLibraryGames,
  saveTextBlock,
  type TextLibraryPanelData,
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

const errorUsages = (error: unknown): TextBlockUsage[] => {
  if (!(error instanceof PanelApiError) || typeof error.details !== "object" || error.details === null || !("usages" in error.details) || !Array.isArray(error.details.usages)) return [];
  const kinds = new Set<TextBlockUsage["kind"]>(["block", "command", "faq", "timer", "overlay", "event"]);
  return error.details.usages.flatMap((usage: unknown) => {
    if (typeof usage !== "object" || usage === null) return [];
    const record = usage as Record<string, unknown>;
    return typeof record.kind === "string" && kinds.has(record.kind as TextBlockUsage["kind"]) && typeof record.label === "string"
      ? [{ kind: record.kind as TextBlockUsage["kind"], label: record.label }]
      : [];
  });
};

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

const updateLibraryCache = (
  current: unknown,
  update: (library: TextLibraryPanelData) => TextLibraryPanelData,
  fallback: TextLibraryPanelData | null,
): unknown => {
  const candidate = typeof current === "object" && current !== null && Array.isArray(Reflect.get(current, "blocks")) && Array.isArray(Reflect.get(current, "categories"))
    ? current
    : fallback;
  if (candidate === null) return current;
  return update(candidate as TextLibraryPanelData);
};

export default function TextLibraryPanel(props: ModulePanelProperties): ReactElement {
  return <TextLibraryPanelContent key={props.channelId} {...props} />;
}

function TextLibraryPanelContent({ channelId, language, canManage = true, textBlockConditions = [] }: ModulePanelProperties): ReactElement {
  const labels = useMemo(() => textLibraryTexts(language), [language]);
  const resolvedLanguage = language === "en" ? "en" : "de";
  const common = dashboardCommonTexts(resolvedLanguage);
  const searchGames = useCallback((query: string) => searchTextLibraryGames(channelId, query), [channelId]);
  const lookupGames = useCallback((ids: readonly string[]) => lookupTextLibraryGames(channelId, ids), [channelId]);
  const queryClient = useDashboardQueryClient();
  const libraryQuery = useModuleQuery(channelId, "text_library", "library", (signal) => loadTextLibrary(channelId, signal));
  const data = libraryQuery.data ?? null;
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
  const [deleteBlockedResult, setDeleteBlockedResult] = useState<{ name: string; usages: TextBlockUsage[] } | null>(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [attemptedSave, setAttemptedSave] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [serverConflict, setServerConflict] = useState(false);
  const initialSelectionDone = useRef(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [categoryDrafts, setCategoryDrafts] = useState<Record<string, string>>({});
  const [previewNow, setPreviewNow] = useState(() => Date.now());

  const patchDraft = (next: DraftBlock): void => {
    setDraft(next);
    setSaveError(null);
  };

  useEffect(() => {
    const timer = window.setInterval(() => setPreviewNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const write = useCallback(<Value,>(
    baselineRevision: number | null,
    mutation: (revision: number | null) => Promise<Value>,
    updateCache: (current: unknown, result: Value) => unknown,
  ): Promise<Value> => runModuleQueryWrite(queryClient, channelId, "text_library", "library", mutation, {
      baselineRevision,
      updateCache,
      relatedParts: [
        { moduleId: "text_commands", part: "template-variables" },
        { moduleId: "faq", part: "panel" },
        { moduleId: "timers", part: "panel" },
      ],
    }), [channelId, queryClient]);

  useEffect(() => {
    if (libraryQuery.isError) notify({ tone: "error", message: labels.loadError });
  }, [libraryQuery.isError, labels.loadError]);

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
    draft.variants.some((variant) => !validTextBlockConditions(variant.conditions) || variant.texts.length === 0 || variant.texts.length > TEXT_BLOCK_MAXIMUMS.textsPerVariant || variant.texts.some((text) => text.trim().length === 0 || templateTextLength(text) > TEXT_BLOCK_MAXIMUMS.textLength));
  const valid = draft !== null && !nameInvalid && !nameTaken && !nameReserved && !variantInvalid && draft.categoryId.length > 0;
  const dirty = draft !== null && (revision === null || (baselineDraft !== null && JSON.stringify(draft) !== JSON.stringify(baselineDraft)));
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
  const previewChatStatus: ("viewer" | "subscriber" | "vip" | "moderator" | "broadcaster")[] | null = simulatedContext === "command"
    ? [simulatedTier === "everyone" ? "viewer" : simulatedTier as "subscriber" | "vip" | "moderator" | "broadcaster"]
    : null;
  const previewInput = {
    text: previewTemplate,
    templateContext: simulatedContext === "command" ? "chat_command" as const : "event" as const,
    streamState: simulatedStream,
    game: simulatedGame[0] ?? null,
    chatStatus: previewChatStatus,
  };
  const preview = useTemplatePreview({
    text: previewTemplate,
    refreshKey: libraryQuery.dataUpdatedAt,
    requestKey: `${simulatedContext}:${simulatedStream}:${simulatedGameId ?? ""}:${simulatedTier}`,
    enabled: data !== null && previewTemplate.length > 0,
    render: () => renderTextLibraryPreview(channelId, previewInput).then((result) => result.text),
  });
  const previewText = previewTemplate.length === 0 ? "" : preview.value ?? previewTemplate;
  const previewOverflow = matchingVariant === null ? null : estimateEmbeddedBlockOverflow(matchingVariant.texts, blockVariants, data?.templateVariables ?? []);
  const nestedVariants = (name: string, visited = new Set<string>()): TextBlockVariant[] => {
    if (visited.has(name)) return [];
    visited.add(name);
    const variants = draft !== null && name === draft.name ? draft.variants : blockByName.get(name)?.variants ?? [];
    const nestedNames = [...new Set(variants.flatMap((variant) => variant.texts.flatMap(blockReferencesInText)))];
    return [...variants, ...nestedNames.flatMap((nestedName) => nestedVariants(nestedName, new Set(visited)))];
  };
  const variantsInDraftTree = draft === null ? [] : nestedVariants(draft.name);
  const roleConditionUsedOutsideCommand = draft !== null && variantsInDraftTree.some((variant) => variant.conditions.minimumTier !== undefined) &&
    (data?.usages[selectedName ?? draft.name] ?? []).some((usage) => usage.kind !== "command");
  const commandInputVariables = new Set(data?.templateVariables
    .filter((variable) => variable.unavailableContextText !== undefined && !(variable.contexts?.includes("event") ?? true))
    .map((variable) => variable.name) ?? []);
  const inputVariableUsedOutsideCommand = draft !== null && variantsInDraftTree.some((variant) => variant.texts.some((text) =>
    templateVariableNames(text).some((name) => commandInputVariables.has(name)),
  )) &&
    (data?.usages[selectedName ?? draft.name] ?? []).some((usage) => usage.kind !== "command");
  const blockUsages = draft === null ? [] : data?.usages[selectedName ?? draft.name] ?? [];

  // Bumped on every editor switch; an obsolete save/delete must not touch the newer editor.
  const editorSwitch = useRef(0);

  const openCreateNow = (): void => {
    editorSwitch.current += 1;
    const categoryId = data?.categories[0]?.id ?? "";
    const initial = newDraft(categoryId);
    setSelectedName(null);
    setDraft(initial);
    setBaselineDraft(initial);
    setRevision(null);
    setAttemptedSave(false);
    setSaveError(null);
    setServerConflict(false);
    setDeleteBlockedResult(null);
  };

  const closeEditorNow = (): void => {
    editorSwitch.current += 1;
    setSelectedName(null);
    setDraft(null);
    setBaselineDraft(null);
    setRevision(null);
    setMobileDetailOpen(false);
    setConfirmingDelete(false);
    setAttemptedSave(false);
    setSaveError(null);
    setServerConflict(false);
    setDeleteBlockedResult(null);
  };

  const selectBlockNow = (block: TextBlock): void => {
    editorSwitch.current += 1;
    setSelectedName(block.name);
    setDraft(draftFromBlock(block));
    setBaselineDraft(draftFromBlock(block));
    setRevision(block.revision);
    setAttemptedSave(false);
    setSaveError(null);
    setServerConflict(false);
    setDeleteBlockedResult(null);
  };

  const saveDraft = async (): Promise<string | null> => {
    setAttemptedSave(true);
    setSaveError(null);
    if (draft === null || !valid || !canManage) {
      setSaveError(labels.saveError);
      return labels.saveError;
    }
    setPending(true);
    const startedSwitch = editorSwitch.current;
    try {
      const payload = {
        ...draft,
        variants: draft.variants.map((variant, index) => index === draft.variants.length - 1 ? { ...variant, conditions: {} } : variant),
      };
      const originalName = selectedName;
      const saved = await write(revision, (baselineRevision) => baselineRevision === null
        ? createTextBlock(channelId, payload)
        : originalName === null
          ? Promise.reject(new Error("A text block name is required for an update."))
          : saveTextBlock(channelId, originalName, { ...payload, revision: baselineRevision }), (current, result) => updateLibraryCache(current, (library) => {
          const usages = { ...library.usages };
          if (originalName !== null && originalName !== result.name) {
            const previousUsages = usages[originalName];
            Reflect.deleteProperty(usages, originalName);
            if (previousUsages !== undefined) usages[result.name] = previousUsages;
          }
          return {
            ...library,
            blocks: [
              ...library.blocks.filter((block) => block.name !== result.name && block.name !== originalName),
              result,
            ],
            usages,
          };
        }, data));
      if (editorSwitch.current !== startedSwitch) return null;
      setSelectedName(saved.name);
      setDraft(draftFromBlock(saved));
      setBaselineDraft(draftFromBlock(saved));
      setRevision(saved.revision);
      setAttemptedSave(false);
      setServerConflict(false);
      return null;
    } catch (caught: unknown) {
      if (editorSwitch.current !== startedSwitch) return null;
      const code = errorCode(caught);
      const path = errorPath(caught);
      const contentIssues = templateContentIssues(caught, labels);
      const message = code === "text_library_reference_cycle" ? labels.cycle(path)
        : code === "text_library_reference_depth_exceeded" ? labels.depth(path)
          : code === "text_library_template_usage_invalid" && contentIssues.length > 0 ? contentIssues.join(" ")
            : code === null ? labels.saveError : labels.errors[code] ?? (caught instanceof PanelApiError && caught.status === 409 ? labels.conflict : labels.saveError);
      setSaveError(message);
      if (code === "text_library_block_conflict") setServerConflict(true);
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
    if (revision === null) {
      editorSwitch.current += 1;
      setSelectedName(null);
      setDraft(null);
      setBaselineDraft(null);
      setRevision(null);
      setMobileDetailOpen(false);
      setAttemptedSave(false);
      setSaveError(null);
      setServerConflict(false);
      return;
    }
    if (baselineDraft !== null) setDraft({ ...baselineDraft, games: [...baselineDraft.games], variants: baselineDraft.variants.map((variant) => ({ ...variant, conditions: { ...variant.conditions }, texts: [...variant.texts] })) });
    setSaveError(null);
    setServerConflict(false);
  }, [baselineDraft, revision]);
  const draftGuard = useDraftGuard(dirty, saveDraft, discardDraft);
  const guardSwitch = draftGuard.guardSwitch;
  useEffect(() => registerDashboardNavigationGuard((proceed, cancel) => {
    if (pending) {
      cancel();
      return;
    }
    guardSwitch(proceed, cancel);
  }), [guardSwitch, pending]);
  const openCreate = (): void => {
    if (pending) return;
    guardSwitch(() => { openCreateNow(); setMobileDetailOpen(true); });
  };
  const openDelete = (): void => {
    if (!pending) guardSwitch(() => { setConfirmingDelete(true); });
  };
  const closeEditor = (): void => { if (!pending) guardSwitch(closeEditorNow); };
  const selectBlock = (block: TextBlock): void => {
    if (pending) return;
    if (block.name === selectedName) {
      setMobileDetailOpen(true);
      return;
    }
    guardSwitch(() => { selectBlockNow(block); setMobileDetailOpen(true); });
  };

  useEffect(() => {
    if (data === null || initialSelectionDone.current) return;
    initialSelectionDone.current = true;
    const first = data.blocks[0];
    if (first === undefined || selectedName !== null || draft !== null) return;
    const startedSwitch = editorSwitch.current;
    const timer = window.setTimeout(() => {
      if (editorSwitch.current !== startedSwitch) return;
      setSelectedName(first.name);
      setDraft(draftFromBlock(first));
      setBaselineDraft(draftFromBlock(first));
      setRevision(first.revision);
    }, 0);
    return () => { window.clearTimeout(timer); };
  }, [data, draft, selectedName]);

  useEffect(() => {
    if (data === null || selectedName === null || revision === null) return;
    const startedSwitch = editorSwitch.current;
    const timer = window.setTimeout(() => {
      if (editorSwitch.current !== startedSwitch) return;
      const latest = data.blocks.find((block) => block.name === selectedName);
      if (latest === undefined) {
        if (dirty) setServerConflict(true);
        else closeEditorNow();
        return;
      }
      if (latest.revision === revision) return;
      if (dirty) {
        setServerConflict(true);
        return;
      }
      const next = draftFromBlock(latest);
      setDraft(next);
      setBaselineDraft(next);
      setRevision(latest.revision);
      setServerConflict(false);
    }, 0);
    return () => { window.clearTimeout(timer); };
  }, [data, dirty, revision, selectedName]);

  const reloadCurrent = (): void => {
    if (selectedName === null) return;
    const startedSwitch = editorSwitch.current;
    const blockName = selectedName;
    setPending(true);
    void refetchModuleQueryData<TextLibraryPanelData>(queryClient, channelId, "text_library", "library").then((latestData) => {
      if (editorSwitch.current !== startedSwitch) return;
      const latest = latestData.blocks.find((block) => block.name === blockName);
      if (latest === undefined) {
        closeEditorNow();
        return;
      }
      const next = draftFromBlock(latest);
      setDraft(next);
      setBaselineDraft(next);
      setRevision(latest.revision);
      setSaveError(null);
      setServerConflict(false);
      setAttemptedSave(false);
    }).catch(() => {
      notify({ tone: "error", message: labels.loadError });
    }).finally(() => {
      setPending(false);
    });
  };

  const removeBlock = async (): Promise<void> => {
    if (selectedName === null || revision === null || !canManage) return;
    const startedSwitch = editorSwitch.current;
    const deletedName = selectedName;
    setPending(true);
    try {
      await write(revision, (baselineRevision) => {
        if (baselineRevision === null) throw new Error("A text block revision is required for deletion.");
        return deleteTextBlock(channelId, deletedName, baselineRevision);
      }, (current) => updateLibraryCache(current, (library) => {
        const usages = { ...library.usages };
        Reflect.deleteProperty(usages, deletedName);
        return { ...library, blocks: library.blocks.filter((block) => block.name !== deletedName), usages };
      }, data));
      if (editorSwitch.current !== startedSwitch) return;
      setSelectedName(null);
      setDraft(null);
      setBaselineDraft(null);
      setRevision(null);
      setMobileDetailOpen(false);
      setConfirmingDelete(false);
    } catch (caught: unknown) {
      if (editorSwitch.current !== startedSwitch) return;
      const code = errorCode(caught);
      if (code === "text_library_block_in_use") {
        const responseUsages = errorUsages(caught);
        let refreshedUsages: readonly TextBlockUsage[] = data?.usages[deletedName] ?? [];
        try {
          const refreshed = await libraryQuery.refetch();
          refreshedUsages = refreshed.data?.usages[deletedName] ?? refreshedUsages;
        } catch {
          // The DELETE response remains the source of truth when the refresh fails.
        }
        if (editorSwitch.current !== startedSwitch) return;
        setConfirmingDelete(false);
        setDeleteBlockedResult({ name: deletedName, usages: responseUsages.length > 0 ? responseUsages : [...refreshedUsages] });
      } else {
        notify({ tone: "error", message: code === "text_library_block_conflict" ? labels.conflict : labels.saveError });
      }
    } finally {
      setPending(false);
    }
  };

  const updateCondition = (id: string, update: (conditions: TextBlockConditions) => TextBlockConditions): void => {
    if (draft === null) return;
    patchDraft({ ...draft, variants: updateVariant(draft.variants, id, (variant) => ({ ...variant, conditions: update(variant.conditions) })) });
  };

  const saveCategory = async (category: TextBlockCategory): Promise<void> => {
    const name = categoryDrafts[category.id] ?? categoryLabel(category, labels);
    if (!canManage || name.trim().length === 0) return;
    setPending(true);
    try {
      await write(null, async () => {
        await renameTextCategory(channelId, category.id, name.trim());
        return { id: category.id, name: name.trim() };
      }, (current, result) => updateLibraryCache(current, (library) => ({
        ...library,
        categories: library.categories.map((entry) => entry.id === result.id ? { ...entry, customName: result.name } : entry),
      }), data));
      setCategoryDrafts({});
    } catch { notify({ tone: "error", message: labels.saveError }); } finally { setPending(false); }
  };

  const addCategory = async (): Promise<void> => {
    if (!canManage || newCategoryName.trim().length === 0) return;
    setPending(true);
    try {
      await write(null, () => createTextCategory(channelId, newCategoryName.trim()), (current, result) => updateLibraryCache(current, (library) => ({
        ...library,
        categories: library.categories.some((category) => category.id === result.id)
          ? library.categories.map((category) => category.id === result.id ? result : category)
          : [...library.categories, result],
      }), data));
      setNewCategoryName("");
    } catch (caught: unknown) {
      const code = errorCode(caught);
      notify({ tone: "error", message: code === null ? labels.saveError : labels.errors[code] ?? labels.categoryLimit });
    } finally { setPending(false); }
  };

  const removeCategory = async (category: TextBlockCategory): Promise<void> => {
    if (!canManage) return;
    setPending(true);
    try {
      await write(null, async () => {
        await deleteTextCategory(channelId, category.id);
        return category.id;
      }, (current, deletedId) => updateLibraryCache(current, (library) => ({
        ...library,
        categories: library.categories.filter((entry) => entry.id !== deletedId),
      }), data));
    }
    catch (caught: unknown) { notify({ tone: "error", message: errorCode(caught) === "text_library_category_not_empty" ? labels.categoryDeleteBlocked : labels.saveError }); }
    finally { setPending(false); }
  };

  if (data === null) return <div className="text-library">
    <CollectionPage
      title={labels.library}
      toolbar={<ListToolbar
        className="text-library__list-toolbar"
        language={resolvedLanguage}
        searchLabel={labels.search}
        searchLabelVisible
        searchPlaceholder={labels.searchPlaceholder}
        searchClearLabel={common.clearSearch}
        searchValue={search}
        onSearchChange={setSearch}
        filtersLabel={labels.library}
        filters={<>
          <Select label={labels.categoryFilter} value="" onChange={() => undefined}
            options={[{ value: "", label: labels.allCategories }]} disabled />
          <GameMultiSelect searchGames={searchGames} lookupGames={lookupGames} value={gameFilter} onChange={setGameFilter}
            messages={{ ...labels.gameMultiSelect, label: labels.gameFilter }} compact disabled />
        </>}
        create={{ label: labels.addBlock, onClick: openCreate, disabled: true, ...(!canManage ? { reason: labels.managementLocked } : {}) }}
        createPlacement="after-search"
        usage={{ count: 0, maximum: TEXT_BLOCK_MAXIMUMS.blocksPerChannel, copy: {
          countSuffix: labels.countSuffix,
          filteredInfix: common.of,
          filteredSuffix: labels.filteredSuffix,
          limitInfix: common.of,
          limitSuffix: labels.limitSuffix,
          loadedSuffix: common.loaded,
        } }}
      />}
      list={<LoadState variant="panel-1200" status={libraryQuery.isError ? "error" : "loading"}
        loading={<LoadStateLines rows={8} height={42} />}
        empty={<div />}
        error={<p>{labels.loadError}</p>}
        queryError={{ message: labels.loadError, onRetry: () => { void libraryQuery.refetch(); } }}
        refreshError={libraryQuery.isRefetchError}
      >{null}</LoadState>}
      detail={<EmptyState title={common.chooseCollection} description={common.editSelection} />}
    />
  </div>;
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
    : atBlockLimit ? labels.blockLimitReached(data.blocks.length, TEXT_BLOCK_MAXIMUMS.blocksPerChannel) : undefined;

  return (
    <section className="text-library" aria-label={labels.library}>

      <CollectionPage
        title={labels.library}
        toolbar={<ListToolbar
            className="text-library__list-toolbar"
            language={resolvedLanguage}
            searchLabel={labels.search}
            searchLabelVisible
            searchPlaceholder={labels.searchPlaceholder}
            searchClearLabel={common.clearSearch}
            searchValue={search}
            onSearchChange={setSearch}
            createPlacement="after-search"
            filtersLabel={labels.library}
            filters={<>
              <Select label={labels.categoryFilter} value={categoryFilter} onChange={(value) => setCategoryFilter(value ?? "")} options={[{ value: "", label: labels.allCategories }, ...categories]} />
              <GameMultiSelect searchGames={searchGames} lookupGames={lookupGames} value={gameFilter} onChange={setGameFilter}
                messages={{ ...labels.gameMultiSelect, label: labels.gameFilter }} compact />
            </>}
            create={{ label: labels.addBlock, onClick: openCreate, disabled: pending || createReason !== undefined, ...(createReason === undefined ? {} : { reason: createReason }) }}
            usage={{ count: data.blocks.length, maximum: TEXT_BLOCK_MAXIMUMS.blocksPerChannel, ...(activeFilters.length === 0 ? {} : { filteredCount: visibleBlocks.length }), copy: { countSuffix: labels.countSuffix, filteredInfix: common.of, filteredSuffix: labels.filteredSuffix, limitInfix: common.of, limitSuffix: labels.limitSuffix, loadedSuffix: common.loaded } }}
            {...(activeFilters.length === 0 ? {} : { activeFilters: activeFilters.join(" · "), activeFiltersLabel: labels.activeFilters, resetLabel: labels.resetFilters, onReset: () => { setSearch(""); setCategoryFilter(""); setGameFilter([]); } })}
          />}
        list={data.blocks.length === 0 ? null : <LoadState
          variant="panel-0"
          status="success"
          loading={<LoadStateLines rows={8} height={34} />}
          empty={<div />}
          error={<p>{labels.loadError}</p>}
          queryError={{ message: labels.loadError, onRetry: () => { void libraryQuery.refetch(); } }}
          refreshError={libraryQuery.isRefetchError}
        ><div data-testid="text-library-list-slot" className="text-library__list">
          {visibleBlocks.length === 0 ? <p className="text-library__empty-search">{labels.empty}</p> : visibleBlocks.map((block) => {
            const category = data.categories.find((entry) => entry.id === block.categoryId);
            const usages = data.usages[block.name] ?? [];
            const sample = block.variants.flatMap((variant) => variant.texts)[0] ?? "";
            return <button type="button" className={`text-library__item${selectedName === block.name ? " is-selected" : ""}`} aria-current={selectedName === block.name ? "true" : undefined} key={block.name} disabled={pending} onClick={() => { selectBlock(block); }}>
              <span className="text-library__item-dot" aria-hidden="true" />
              <span className="text-library__item-copy">
                <strong>{`{text.${block.name}}`}</strong>
                <small>{sample}</small>
                <span className="text-library__item-meta">{category === undefined ? block.categoryId : categoryLabel(category, labels)} · {labels.variantsCount(block.variants.length)}</span>
              </span>
              <Badge tone={usages.length === 0 ? "neutral" : "brand"}>{labels.usesCount(usages.length)}</Badge>
            </button>;
          })}
        </div></LoadState>}
      detail={draft === null ? <EmptyState title={common.chooseCollection} description={common.editSelection} /> : (

          <div className="text-library__editor">
            <PageHeader
              kind="texts"
              icon={null}
              title={isCreate ? labels.addBlock : `{text.${draft.name || selectedName || ""}}`}
              meta={isCreate ? labels.nameHint : labels.usesCount(blockUsages.length)}
              {...(!canManage ? { lockHint: labels.operatorReason } : {})}
              {...(!isCreate ? { actions: <ActionMenu label={common.moreActions} items={[
                  {
                    label: labels.deleteMenuLabel,
                    onSelect: () => { if (canManage) openDelete(); },
                    disabled: !canManage || pending || blockUsages.length > 0,
                    danger: true,
                    ...(!canManage ? { description: labels.deleteOperatorReason }
                      : blockUsages.length > 0 ? { description: labels.deleteBlockedReason(blockUsages.length) }
                        : pending ? { description: common.saving } : {}),
                  },
                  {
                    label: labels.viewUsages,
                    onSelect: () => { setDeleteBlockedResult({ name: selectedName ?? draft.name, usages: [...blockUsages] }); },
                  },
                ]} /> } : {})}
              {...(canManage ? { save: {
                dirty,
                pending,
                ...(saveError === null ? {} : { error: saveError }),
                invalid: !valid,
                invalidMessage: labels.saveError,
                onInvalidSave: () => { setAttemptedSave(true); },
                persistent: true,
                ...(serverConflict && !isCreate ? { conflict: { message: labels.conflict, reloadLabel: labels.reload, onReload: reloadCurrent } } : {}),
                onSave: () => { void saveDraftWithToast(); },
                onDiscard: discardDraft,
                saveLabel: isCreate ? labels.create : labels.save,
                discardLabel: common.discard,
                savedLabel: common.saved,
                pendingLabel: common.saving,
              } } : {})}
            />
            <div className="text-library__editor-body">
              {canManage ? <>
              <Section title={labels.generalSection} variant="inspector">
                <InspectorFieldRow label={labels.name} help={labels.nameHint}>
                  <Field
                    label={labels.name}
                    hint={labels.nameHint}
                    value={draft.name}
                    onChange={(name) => patchDraft({ ...draft, name: name.toLowerCase().replace(/[^a-z0-9_]/gu, "_").slice(0, 32) })}
                    disabled={pending}
                    {...((attemptedSave || draft.name.length > 0) && nameInvalid ? { error: labels.nameInvalid } : nameTaken ? { error: labels.nameExists } : nameReserved ? { error: labels.nameReserved } : {})}
                    mono
                  />
                </InspectorFieldRow>
                <InspectorFieldRow label={labels.category}>
                  <Select label={labels.category} value={draft.categoryId} onChange={(value) => value !== null && patchDraft({ ...draft, categoryId: value })} disabled={pending} options={categories} />
                </InspectorFieldRow>
                <InspectorFieldRow label={labels.gameBound} help={labels.gameMultiSelect.hint}>
                  <GameMultiSelect searchGames={searchGames} lookupGames={lookupGames} value={draft.games} onChange={(games) => patchDraft({ ...draft, games })} messages={{ ...labels.gameMultiSelect, label: labels.gameBound }} disabled={pending} />
                </InspectorFieldRow>
              </Section>

              <Section title={labels.variants} variant="inspector" headingAction={<Badge>{labels.variantsCount(draft.variants.length)}</Badge>}>
                {draft.variants.map((variant, index) => {
                  const isDefault = index === draft.variants.length - 1;
                  const variantOverflow = estimateEmbeddedBlockOverflow(variant.texts, blockVariants, data.templateVariables);
                  return (
                    <article className="text-library__variant" key={variant.id}>
                      <div className="text-library__variant-heading">
                        <strong>{isDefault ? labels.defaultVariant : labels.variant(index + 1)}</strong>
                        <span className="muted">{isDefault ? labels.noConditions : conditionSummary(variant, labels, conditionDefinitions, language === "en" ? "en" : "de")}</span>
                        {isDefault ? null : <div className="form-actions">
                          {index === 0 ? null : <Button size="compact" variant="neutral" disabled={pending} onClick={() => patchDraft({ ...draft, variants: draft.variants.map((entry, entryIndex, all) => entryIndex === index - 1 ? all[index] as TextBlockVariant : entryIndex === index ? all[index - 1] as TextBlockVariant : entry) })}>{labels.moveUp}</Button>}
                          {index >= draft.variants.length - 2 ? null : <Button size="compact" variant="neutral" disabled={pending} onClick={() => patchDraft({ ...draft, variants: draft.variants.map((entry, entryIndex, all) => entryIndex === index + 1 ? all[index] as TextBlockVariant : entryIndex === index ? all[index + 1] as TextBlockVariant : entry) })}>{labels.moveDown}</Button>}
                          <Button size="compact" danger="subtle" disabled={pending} onClick={() => patchDraft({ ...draft, variants: draft.variants.filter((entry) => entry.id !== variant.id) })}>{labels.removeVariant}</Button>
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
                            {variant.conditions.game === undefined ? null : <GameMultiSelect
                              searchGames={searchGames}
                              lookupGames={lookupGames}
                              value={variant.conditions.game.game.id.length === 0 ? [] : [variant.conditions.game.game]}
                              onChange={(games) => updateCondition(variant.id, (conditions) => games[0] === undefined ? withoutCondition(conditions, "game") : { ...conditions, game: { mode: conditions.game?.mode ?? "is", game: games[0] } })}
                              messages={{ ...labels.gameMultiSelect, label: labels.gameCondition }}
                              visuallyHiddenLabel
                              disabled={pending}
                            />}
                          </fieldset>
                        </div>
                        <p className="form-error" style={{ minHeight: "var(--s6)", margin: 0 }}>
                          {variant.conditions.game?.game.id.length === 0 ? labels.gameMultiSelect.hint : ""}
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
                            <TemplateTextField label={`${labels.text}${variant.texts.length > 1 ? ` ${String(textIndex + 1)}` : ""}`} hint={labels.textHint} value={text} onChange={(value) => patchDraft({ ...draft, variants: updateVariant(draft.variants, variant.id, (entry) => ({ ...entry, texts: entry.texts.map((current, currentIndex) => currentIndex === textIndex ? value : current) })) })} maxLength={TEXT_BLOCK_MAXIMUMS.textLength} disabled={pending} variables={[
                              ...data.templateVariables.filter((variable) => !variable.isTextBlock).flatMap((variable) => {
                                if (variable.group === undefined) return [];
                                const pickerCopy = variable.picker?.[resolvedLanguage];
                                const systemCopy = variable.source === "system"
                                  ? systemTemplateVariableLocale[resolvedLanguage][variable.name as keyof typeof systemTemplateVariableLocale.de]
                                  : undefined;
                                const sourceGroup = registeredModuleTemplateGroup(variable, resolvedLanguage);
                                return [{
                                  name: variable.name,
                                  label: pickerCopy?.label ?? systemCopy?.label ?? variable.name,
                                  description: pickerCopy?.description ?? systemCopy?.description ?? variable.localizedDescription?.[resolvedLanguage] ?? variable.description ?? variable.name,
                                  sample: systemCopy?.sample ?? variable.sample,
                                  ...(pickerCopy?.sample === undefined ? {} : { pickerSample: pickerCopy.sample }),
                                  group: variable.group,
                                  kind: variable.moduleId === "host" ? variable.source === "channel" ? "channel" as const : "system" as const : "module" as const,
                                  ...(sourceGroup === undefined ? {} : { sourceGroup }),
                                  ...(variable.external === undefined ? {} : { external: variable.external }),
                                  ...(variable.parameters === undefined ? {} : { parameters: variable.parameters }),
                                }];
                              }),
                              ...data.blocks.filter((block) => !reservedNames.has(block.name)).map((block) => ({ name: `text.${block.name}`, label: `text.${block.name}`, description: labels.variableDescription(block.name), sample: block.variants.flatMap((entry) => entry.texts)[0] ?? "", group: "channel" as const, isTextBlock: true })),
                            ]} messages={{
                              countLabel: (count, maximum) => `${String(count)} / ${String(maximum)}`,
                              previewCountLabel: (count) => String(count),
                              openBrace: labels.openBrace,
                              unknownVariable: labels.unknownVariable,
                              insertSuggestionLabel: labels.insertSuggestionLabel,
                              insertionLimit: labels.insertionLimit,
                              worstCaseLength: (length, maximum) => `${String(length)} / ${String(maximum)}`,
                              picker: labels.picker,
                            }} />
                            {variant.texts.length <= 1 ? null : <Button size="compact" danger="subtle" disabled={pending} onClick={() => patchDraft({ ...draft, variants: updateVariant(draft.variants, variant.id, (entry) => ({ ...entry, texts: entry.texts.filter((_entry, entryIndex) => entryIndex !== textIndex) })) })}>{labels.removeText}</Button>}
                          </div>
                        ))}
                        {variant.texts.length >= TEXT_BLOCK_MAXIMUMS.textsPerVariant ? null : <Button size="compact" disabled={pending} onClick={() => patchDraft({ ...draft, variants: updateVariant(draft.variants, variant.id, (entry) => ({ ...entry, texts: [...entry.texts, ""] })) })}>{labels.addText}</Button>}
                      </div>
                      <p className={`text-library__warning${variantOverflow === null ? " is-empty" : ""}`} role={variantOverflow === null ? undefined : "note"} aria-live="polite"
                        style={{ minHeight: "var(--s6)", margin: 0 }}
                        title={variantOverflow === null ? undefined : labels.previewTooLong(variantOverflow.blockNames)}>
                        {variantOverflow === null ? "" : labels.previewTooLong(variantOverflow.blockNames)}
                      </p>
                    </article>
                  );
                })}
                {draft.variants.length >= TEXT_BLOCK_MAXIMUMS.variantsPerBlock ? null : <Button disabled={pending} onClick={() => patchDraft({ ...draft, variants: [...draft.variants.slice(0, -1), newVariant(), draft.variants[draft.variants.length - 1] as TextBlockVariant] })}>{labels.addVariant}</Button>}
              </Section>
              </> : <>
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

              <Section title={labels.preview} variant="inspector">
                <div className="text-library__condition-grid">
                  <Select label={labels.simulateStream} value={simulatedStream} onChange={(value) => value !== null && setSimulatedStream(value as "online" | "offline")} options={[{ value: "online", label: labels.online }, { value: "offline", label: labels.offline }]} />
                  <Select label={labels.simulateContext} value={simulatedContext} onChange={(value) => value !== null && setSimulatedContext(value as "command" | "event")} options={[{ value: "command", label: labels.commandContext }, { value: "event", label: labels.eventContext }]} />
                  {simulatedContext === "command" ? <Select label={labels.minimumTier} value={simulatedTier} onChange={(value) => value !== null && setSimulatedTier(value)} options={Object.entries(labels.tierLabels).map(([value, label]) => ({ value, label }))} /> : null}
                  <GameMultiSelect searchGames={searchGames} lookupGames={lookupGames} value={simulatedGame} onChange={(games) => setSimulatedGame(games.slice(0, 1))} messages={{ ...labels.gameMultiSelect, label: labels.gameCondition }} />
                </div>
                <div data-testid="text-library-preview-slot">
                  {matchingVariant === null ? <p className="muted">{blockUnavailableForGame ? labels.blockUnavailableForGame : labels.noMatchingVariant}</p> : <>
                    <p className="muted" style={{ minHeight: "var(--s6)", margin: 0 }}>{labels.selectedVariant(isDefaultVariant(matchingVariant, draft) ? labels.defaultVariant : labels.variant(draft.variants.findIndex((variant) => variant.id === matchingVariant.id) + 1))}</p>
                    <div className="text-library__preview-output">
                      <ChatPreview label={labels.preview} text={previewText} speaker="Bot" countLabel={String(previewText.length)} />
                    </div>
                  </>}
                </div>
                <p className={`text-library__warning${previewWarnings.length === 0 ? " is-empty" : ""}`} data-testid="text-library-warning-slot" role={previewWarnings.length > 0 ? "note" : undefined} aria-live="polite"
                  style={{ minHeight: "var(--s8)", margin: 0 }}>
                  {previewWarnings.join(" ")}
                </p>
              </Section>

              <Section title={labels.uses} variant="inspector">
                <div data-testid="text-library-usage-slot" style={{ minHeight: "var(--s12)", maxHeight: "calc(var(--s10) * 7)", overflowY: "auto" }}>
                  {blockUsages.length === 0 ? <p className="muted">{labels.noUsages}</p> : <ul className="text-library__usages">{blockUsages.map((usage, index) => <li key={`${usage.kind}-${usage.label}-${String(index)}`}><span>{labels.usageKind[usage.kind]}</span><span>{usage.label}</span></li>)}</ul>}
                  {blockUsages.length === 0 ? null : <p className="muted">{labels.deleteBlocked}</p>}
                </div>
              </Section>

              {isCreate && atBlockLimit ? <RuleNote>{labels.blockLimitReached(data.blocks.length, TEXT_BLOCK_MAXIMUMS.blocksPerChannel)}</RuleNote> : null}
            </div>
            <details className="text-library__settings">
              <summary>{labels.categories}</summary>
              <div className="text-library__settings-body">
                {canManage ? <Section title={labels.categories} variant="inspector">
                  {data.categories.map((category) => {
                    const originalName = categoryLabel(category, labels);
                    const value = categoryDrafts[category.id] ?? category.customName ?? originalName;
                    const isEmpty = categoryBlockCounts.get(category.id) === 0;
                    return <div className="text-library__category-row" key={category.id}>
                      <Field label={`${labels.categoryName}: ${originalName}`} value={value} onChange={(name) => setCategoryDrafts({ ...categoryDrafts, [category.id]: name })} disabled={pending || category.catalogKey !== null} maxLength={40} countLabel={(count, maximum) => `${String(count)} / ${String(maximum)}`} />
                      {category.catalogKey === null ? <>
                        <Button size="compact" disabled={pending || value.trim().length === 0 || value === originalName} onClick={() => { void saveCategory(category); }}>{labels.categoryRename}</Button>
                      <Button size="compact" danger="subtle" disabled={pending || !isEmpty} {...(!isEmpty ? { title: labels.categoryDeleteBlocked } : {})} onClick={() => { void removeCategory(category); }}>{labels.categoryDelete}</Button>
                      </> : null}
                      {!isEmpty ? null : <span className="muted">{labels.categoryEmpty}</span>}
                    </div>;
                  })}
                  <div className="text-library__category-create">
                    <Field label={labels.categoryName} value={newCategoryName} onChange={setNewCategoryName} maxLength={40} countLabel={(count, maximum) => `${String(count)} / ${String(maximum)}`} disabled={pending} />
                    <Button disabled={pending || newCategoryName.trim().length === 0 || data.categories.length >= 25} onClick={() => { void addCategory(); }}>{labels.categoryAdd}</Button>
                    {data.categories.length >= 25 ? <p className="muted">{labels.categoryLimit}</p> : null}
                  </div>
                </Section> : <>
                  <dl className="text-library__read-only-properties">
                    {data.categories.map((category) => <div key={category.id}><dt>{`${labels.categoryName}: ${categoryLabel(category, labels)}`}</dt><dd>{category.customName ?? categoryLabel(category, labels)}</dd></div>)}
                  </dl>
                </>}
              </div>
            </details>
          </div>
        )}
        empty={<EmptyState title={labels.library} description={labels.empty} />}
        detailOpen={mobileDetailOpen}
        backLabel={labels.close}
        closeDetailDisabled={pending}
        onCloseDetail={closeEditor}
      />
      <ConfirmDialog opened={confirmingDelete} title={labels.deleteTitle(selectedName ?? "")} description={labels.deleteConsequence(selectedName ?? "")} confirmLabel={labels.deleteConfirm(selectedName ?? "")} cancelLabel={labels.close} onCancel={() => { setConfirmingDelete(false); }} onConfirm={() => { void removeBlock(); }} pending={pending} danger />
      <Dialog
        opened={deleteBlockedResult !== null}
        title={deleteBlockedResult !== null && deleteBlockedResult.usages.length === 0
          ? labels.usageDialogTitle(deleteBlockedResult.name)
          : labels.deleteBlockedTitle(deleteBlockedResult?.name ?? "")}
        onClose={() => { setDeleteBlockedResult(null); }}
      >
        <p className="ui-dialog__description">{deleteBlockedResult !== null && deleteBlockedResult.usages.length === 0 ? labels.usageDialogDescription : labels.deleteBlocked}</p>
        {deleteBlockedResult === null || deleteBlockedResult.usages.length === 0
          ? <p className="muted">{labels.noUsages}</p>
          : <ul className="text-library__usages">{deleteBlockedResult.usages.map((usage, index) => <li key={`${usage.kind}-${usage.label}-${String(index)}`}><span>{labels.usageKind[usage.kind]}</span><span>{usage.label}</span></li>)}</ul>}
      </Dialog>
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
