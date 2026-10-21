import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import "./panel.css";

import { CollectionPage, EmptyState, ListToolbar, LoadState, LoadStateLines } from "../../../dashboard/ui";
import { dashboardCommonTexts } from "../../../dashboard/locale";
import { moduleQueryKey, runModuleQueryWrite, useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
import type { ModulePanelProperties } from "../../contract";
import { CHAT_VOTE_TEMPLATE_MAXIMUM, type ChatVoteTemplate } from "../contracts";
import { chatVoteDurationText, chatVotingSavedPanelTexts } from "./locale-saved";
import { ChatVoteTemplateInspector } from "./template-inspector";
import type { TemplateInspectorActions } from "./template-inspector";
import { ChatVoteTemplateList } from "./template-list";
import type { ChatVoteTemplateListState } from "./service";
import { deleteChatVoteTemplate, loadChatVoteTemplates, mergeChatVoteTemplateLists } from "./service";

const EMPTY_TEMPLATES: readonly ChatVoteTemplate[] = [];
const DEFAULT_TEMPLATE_DURATION_SECONDS = 120;

const ChatVotingPanel = (properties: ModulePanelProperties): ReactElement =>
  <ChatVotingCollection key={properties.channelId} {...properties} />;

const ChatVotingCollection = ({ channelId, language = "de", canManage = true, onCloseInspector }: ModulePanelProperties): ReactElement => {
  const labels = chatVotingSavedPanelTexts(language);
  const common = dashboardCommonTexts(language);
  const queryClient = useDashboardQueryClient();
  const templatesQuery = useModuleQuery(channelId, "chat_voting", "templates", async (signal) => mergeChatVoteTemplateLists(
    queryClient.getQueryData<ChatVoteTemplateListState>(moduleQueryKey(channelId, "chat_voting", "templates")) ?? null,
    await loadChatVoteTemplates(channelId, signal),
  ));
  const templateState = templatesQuery.data ?? null;
  const templates = templateState?.templates ?? EMPTY_TEMPLATES;
  const count = templateState?.count ?? templates.length;
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedSnapshot, setSelectedSnapshot] = useState<ChatVoteTemplate | null>(null);
  const [templateInspectorKey, setTemplateInspectorKey] = useState<string | null>(null);
  const [newTemplateDraft, setNewTemplateDraft] = useState<ChatVoteTemplate | null>(null);
  const [savedTemplateId, setSavedTemplateId] = useState<string | null>(null);
  const [selectionCleared, setSelectionCleared] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.innerWidth >= 1200);
  const selectedIdRef = useRef<string | null>(null);
  const selectedSnapshotRef = useRef<ChatVoteTemplate | null>(null);
  const inspectorKeyRef = useRef<string | null>(null);
  const inspectorActions = useRef<TemplateInspectorActions | null>(null);
  const automaticSelectionApplied = useRef(false);

  const updateSelection = useCallback((id: string | null, snapshot: ChatVoteTemplate | null, key = id): void => {
    selectedIdRef.current = id;
    selectedSnapshotRef.current = snapshot;
    inspectorKeyRef.current = key;
    setSelectedId(id);
    setSelectedSnapshot(snapshot);
    setTemplateInspectorKey(key);
  }, []);

  const requestInspectorSwitch = useCallback((proceed: () => void): void => {
    const guard = inspectorActions.current?.guardSwitch;
    if (guard === undefined) proceed();
    else guard(proceed);
  }, []);

  const clearSelection = useCallback((): void => {
    updateSelection(null, null);
    setNewTemplateDraft(null);
    setSavedTemplateId(null);
    setSelectionCleared(true);
    setDetailOpen(false);
  }, [updateSelection]);

  const closeInspector = useCallback((): void => {
    requestInspectorSwitch(() => {
      clearSelection();
      onCloseInspector?.();
    });
  }, [clearSelection, onCloseInspector, requestInspectorSwitch]);

  useEffect(() => {
    const resize = (): void => { setWide(window.innerWidth >= 1200); };
    window.addEventListener("resize", resize);
    return () => { window.removeEventListener("resize", resize); };
  }, []);

  useEffect(() => {
    if (templateState === null || !wide || selectionCleared || selectedId !== null || newTemplateDraft !== null || automaticSelectionApplied.current) return;
    const first = templates[0];
    if (first === undefined) return;
    automaticSelectionApplied.current = true;
    requestInspectorSwitch(() => {
      if (selectedIdRef.current === null) {
        updateSelection(first.id, first);
        setDetailOpen(true);
      }
    });
  }, [newTemplateDraft, requestInspectorSwitch, selectedId, selectionCleared, templateState, templates, updateSelection, wide]);

  const createTemplate = (): void => {
    if (!canManage || count >= CHAT_VOTE_TEMPLATE_MAXIMUM) return;
    requestInspectorSwitch(() => {
      const timestamp = new Date().toISOString();
      const id = `new-${crypto.randomUUID()}`;
      const template: ChatVoteTemplate = {
        id,
        channelId,
        shortcut: null,
        title: "",
        resultText: "{vote.result}",
        labels: [],
        answerColors: [],
        offerInCockpit: true,
        freeTextMode: null,
        durationSeconds: DEFAULT_TEMPLATE_DURATION_SECONDS,
        revision: 0,
        legacyAlias: null,
        lastUsedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      setSelectionCleared(false);
      setNewTemplateDraft(template);
      setSavedTemplateId(null);
      updateSelection(id, null);
      setDetailOpen(true);
    });
  };

  const selectTemplate = (template: ChatVoteTemplate): void => {
    requestInspectorSwitch(() => {
      const latest = queryClient.getQueryData<ChatVoteTemplateListState>(moduleQueryKey(channelId, "chat_voting", "templates"));
      const snapshot = latest?.templates.find((entry) => entry.id === template.id) ?? template;
      const sameItem = selectedIdRef.current === template.id;
      const refreshed = sameItem && selectedSnapshotRef.current?.revision !== snapshot.revision;
      setSelectionCleared(false);
      setNewTemplateDraft(null);
      setSavedTemplateId(null);
      updateSelection(template.id, snapshot, sameItem ? inspectorKeyRef.current ?? template.id : template.id);
      if (refreshed) inspectorActions.current?.acceptTemplate(snapshot);
      setDetailOpen(true);
    });
  };

  const removeTemplate = async (template: ChatVoteTemplate): Promise<void> => {
    const nextTemplate: { value: ChatVoteTemplate | null } = { value: null };
    await runModuleQueryWrite(queryClient, channelId, "chat_voting", "templates", () => deleteChatVoteTemplate(channelId, template), {
      baselineRevision: template.revision,
      updateCache: (current) => {
        const previous = current as ChatVoteTemplateListState | undefined;
        if (previous === undefined) return current;
        const position = previous.templates.findIndex((entry) => entry.id === template.id);
        const remaining = previous.templates.filter((entry) => entry.id !== template.id);
        nextTemplate.value = remaining[position < 0 ? 0 : position] ?? remaining.at(-1) ?? null;
        return { ...previous, templates: remaining, count: Math.max(0, previous.count - (position < 0 ? 0 : 1)) };
      },
    });
    if (selectedIdRef.current !== template.id) return;
    const next = nextTemplate.value;
    setNewTemplateDraft(null);
    setSavedTemplateId(null);
    setSelectionCleared(next === null);
    updateSelection(next?.id ?? null, next);
    setDetailOpen(next !== null);
  };

  const onTemplateSaved = (template: ChatVoteTemplate, originId: string): void => {
    if (selectedIdRef.current !== originId) return;
    const key = inspectorKeyRef.current ?? originId;
    updateSelection(template.id, template, key);
    setNewTemplateDraft(null);
    setSavedTemplateId(template.id);
    setSelectionCleared(false);
  };

  const visibleTemplates = templates.filter((template) => {
    const query = search.trim().toLocaleLowerCase();
    return query.length === 0 || [template.title, template.shortcut ?? "", ...template.labels]
      .some((value) => value.toLocaleLowerCase().includes(query));
  });
  const selectedTemplate = newTemplateDraft ?? selectedSnapshot ?? templates.find((template) => template.id === selectedId) ?? null;
  const listStatus = templateState === null ? templatesQuery.isPending ? "loading" : "error"
    : visibleTemplates.length === 0 ? "empty" : "success";
  const createDisabledReason = canManage && count >= CHAT_VOTE_TEMPLATE_MAXIMUM ? labels.templateLimit : undefined;

  const toolbar = <div className="chat-voting-collection__toolbar">
    <h3>{labels.saved}</h3>
    <ListToolbar
      language={language}
      searchLabel={labels.search}
      searchPlaceholder={labels.search}
      searchClearLabel={common.clearSearch}
      searchValue={search}
      onSearchChange={setSearch}
      create={{
        label: labels.create,
        onClick: createTemplate,
        disabled: !canManage || templateState === null || count >= CHAT_VOTE_TEMPLATE_MAXIMUM,
        ...(createDisabledReason === undefined ? {} : { reason: createDisabledReason }),
      }}
    />
  </div>;

  const list = <LoadState
    variant="panel-0"
    status={listStatus}
    loading={<LoadStateLines rows={7} height={48} />}
    empty={<EmptyState title={templates.length === 0 ? labels.emptySaved : common.noMatches} description={templates.length === 0 ? labels.emptySavedDescription : ""} {...(templates.length === 0 && canManage ? { action: { label: labels.create, onClick: createTemplate } } : {})} />}
    error={<p role="alert">{labels.templatesError}</p>}
    queryError={{ title: labels.loadError, message: labels.templatesError, onRetry: () => { void templatesQuery.refetch(); } }}
    refreshError={templatesQuery.isRefetchError}
  >
    <div className={templatesQuery.isRefetchError ? "stale" : undefined}>
      <ChatVoteTemplateList
        templates={visibleTemplates}
        selectedId={selectedTemplate?.id ?? null}
        labels={labels}
        durationText={(seconds) => chatVoteDurationText(seconds, language)}
        onSelect={selectTemplate}
      />
    </div>
  </LoadState>;

  const inspector = selectedTemplate === null ? <EmptyState title={labels.selectionPrompt} description={labels.selectionDescription} /> : <ChatVoteTemplateInspector
    key={templateInspectorKey ?? selectedTemplate.id}
    channelId={channelId}
    template={selectedTemplate}
    templates={templates}
    isNew={newTemplateDraft?.id === selectedTemplate.id}
    initiallySaved={savedTemplateId === selectedTemplate.id}
    language={language}
    canManageContent={canManage}
    onRegisterActions={(actions) => { inspectorActions.current = actions; }}
    onTemplateSaved={onTemplateSaved}
    onClose={closeInspector}
    onDiscardNew={clearSelection}
    onDelete={removeTemplate}
  />;

  return <div className="chat-voting-collection" aria-label={labels.title}>
    <CollectionPage
      headingLevel="h2"
      title={labels.title}
      toolbar={toolbar}
      list={list}
      detail={inspector}
      detailOpen={detailOpen}
      backLabel={labels.back}
      onCloseDetail={() => { requestInspectorSwitch(clearSelection); }}
    />
  </div>;
};

export default ChatVotingPanel;
