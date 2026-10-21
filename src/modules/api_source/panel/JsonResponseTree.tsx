import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";

import { Icon } from "../../../dashboard/ui";
import { createApiSourceJsonPath } from "../domain";

type PathSegment = string | number;
type JsonValueType = "array" | "boolean" | "null" | "number" | "object" | "string";

export interface ApiSourceJsonTreeMessages {
  treeLabel: string;
  responseRoot: string;
  emptyKey: string;
  loading: string;
  empty: string;
  types: Record<JsonValueType, string>;
  moreEntries: (count: number) => string;
  pathTooLong: string;
  pathUnsupported: string;
}

interface JsonResponseTreeProps {
  value: unknown;
  loading?: boolean;
  messages: ApiSourceJsonTreeMessages;
  onSelectPath: (expression: string) => void;
}

interface TreeNode {
  id: string;
  key: string;
  path: PathSegment[];
  value: unknown;
}

const maximumVisibleEntries = 100;
const rootPath: PathSegment[] = [];
const pathId = (path: readonly PathSegment[]): string => JSON.stringify(path);
const rootId = pathId(rootPath);

const valueType = (value: unknown): JsonValueType => {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (typeof value === "object") return "object";
  return typeof value as "boolean" | "number" | "string";
};

const entriesFor = (value: unknown): [string, unknown][] => {
  if (Array.isArray(value)) return value.slice(0, maximumVisibleEntries).map((entry, index) => [String(index), entry]);
  if (typeof value === "object" && value !== null) return Object.entries(value).slice(0, maximumVisibleEntries);
  return [];
};

const entryCount = (value: unknown): number =>
  Array.isArray(value) ? value.length : typeof value === "object" && value !== null ? Object.keys(value).length : 0;

const isBranch = (value: unknown): boolean => entryCount(value) > 0;

const nodeTypeLabel = (value: unknown, messages: ApiSourceJsonTreeMessages): string => messages.types[valueType(value)];

const previewValue = (value: unknown): string => {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  return "";
};

const initialExpandedNodes = (value: unknown): Set<string> => {
  const expanded = new Set<string>();
  const visit = (current: unknown, path: PathSegment[], depth: number): void => {
    if (!isBranch(current) || depth >= 2) return;
    expanded.add(pathId(path));
    for (const [key, child] of entriesFor(current)) {
      const segment: PathSegment = Array.isArray(current) ? Number(key) : key;
      visit(child, [...path, segment], depth + 1);
    }
  };
  visit(value, rootPath, 0);
  return expanded;
};

const visibleNodeIds = (value: unknown, expanded: ReadonlySet<string>): string[] => {
  if (value === undefined) return [rootId];
  const ids: string[] = [];
  const visit = (current: unknown, path: PathSegment[]): void => {
    const id = pathId(path);
    ids.push(id);
    if (!expanded.has(id)) return;
    for (const [key, child] of entriesFor(current)) {
      const segment: PathSegment = Array.isArray(current) ? Number(key) : key;
      visit(child, [...path, segment]);
    }
  };
  visit(value, rootPath);
  return ids;
};

export function JsonResponseTree({ value, loading = false, messages, onSelectPath }: JsonResponseTreeProps): ReactElement {
  const defaultExpanded = useMemo(() => initialExpandedNodes(value), [value]);
  const [expandedState, setExpandedState] = useState(() => ({ value, expanded: defaultExpanded }));
  const expanded = expandedState.value === value ? expandedState.expanded : defaultExpanded;
  const [focusedId, setFocusedId] = useState(rootId);
  const [selectedExpression, setSelectedExpression] = useState<string | undefined>(undefined);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const shouldMoveFocus = useRef(false);
  const focusableIds = useMemo(() => visibleNodeIds(value, expanded), [value, expanded]);
  const activeId = focusableIds.includes(focusedId) ? focusedId : rootId;

  useLayoutEffect(() => {
    if (!shouldMoveFocus.current) return;
    shouldMoveFocus.current = false;
    itemRefs.current.get(activeId)?.focus();
  }, [activeId, focusableIds]);

  const updateExpanded = (nextExpanded: Set<string>): void => {
    setExpandedState({ value, expanded: nextExpanded });
  };

  const setFocus = (id: string): void => {
    if (id === activeId) {
      itemRefs.current.get(id)?.focus();
      return;
    }
    shouldMoveFocus.current = true;
    setFocusedId(id);
  };

  const toggleExpanded = (id: string): void => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    updateExpanded(next);
  };

  const renderNode = (node: TreeNode, isRoot = false): ReactElement => {
    const entries = entriesFor(node.value);
    const branch = entries.length > 0;
    const nodeId = node.id;
    const isExpanded = branch && expanded.has(nodeId);
    const generatedPath = branch ? null : createApiSourceJsonPath(node.path);
    const disabledReason = generatedPath?.reason === "too_long" ? messages.pathTooLong
      : generatedPath?.reason === "unsupported" ? messages.pathUnsupported : undefined;
    const fullPreview = previewValue(node.value);
    const isLongString = typeof node.value === "string" && node.value.length > 60;
    const displayPreview = isLongString ? `${fullPreview.slice(0, 60)}…` : fullPreview;
    const itemLabel = isRoot ? messages.responseRoot : node.key.length === 0 ? messages.emptyKey : node.key;
    const accessibleName = [itemLabel, nodeTypeLabel(node.value, messages), displayPreview].filter(Boolean).join(", ");
    const title = disabledReason === undefined
      ? isLongString ? node.value as string : undefined
      : isLongString ? `${disabledReason} ${node.value as string}` : disabledReason;
    const childCount = entryCount(node.value);

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
      event.stopPropagation();
      const index = focusableIds.indexOf(nodeId);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const offset = event.key === "ArrowDown" ? 1 : -1;
        const nextId = focusableIds[Math.max(0, Math.min(focusableIds.length - 1, index + offset))];
        if (nextId !== undefined) setFocus(nextId);
        return;
      }
      if (event.key === "ArrowRight" && branch) {
        event.preventDefault();
        if (!isExpanded) toggleExpanded(nodeId);
        else {
          const firstEntry = entries[0];
          if (firstEntry !== undefined) {
            const segment: PathSegment = Array.isArray(node.value) ? Number(firstEntry[0]) : firstEntry[0];
            setFocus(pathId([...node.path, segment]));
          }
        }
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        if (branch && isExpanded) toggleExpanded(nodeId);
        else if (node.path.length > 0) setFocus(pathId(node.path.slice(0, -1)));
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (branch) toggleExpanded(nodeId);
        else if (generatedPath?.expression !== null && generatedPath?.expression !== undefined) {
          setSelectedExpression(generatedPath.expression);
          onSelectPath(generatedPath.expression);
        }
      }
    };

    return <div
      key={nodeId}
      ref={(element) => {
        if (element === null) itemRefs.current.delete(nodeId);
        else itemRefs.current.set(nodeId, element);
      }}
      className="api-source-json-tree__node"
      role="treeitem"
      aria-label={accessibleName}
      aria-expanded={branch ? isExpanded : undefined}
      aria-disabled={disabledReason === undefined ? undefined : true}
      aria-selected={generatedPath === null || generatedPath.expression === null ? undefined : selectedExpression === generatedPath.expression}
      title={title}
      tabIndex={activeId === nodeId ? 0 : -1}
      data-tree-node-id={nodeId}
      onFocus={() => { setFocusedId(nodeId); }}
      onKeyDown={onKeyDown}
    >
      <div
        className={`api-source-json-tree__item${disabledReason === undefined ? "" : " api-source-json-tree__item--disabled"}`}
        onClick={(event) => {
          event.stopPropagation();
          if (disabledReason !== undefined) return;
          setFocusedId(nodeId);
          itemRefs.current.get(nodeId)?.focus();
          if (branch) toggleExpanded(nodeId);
          else if (generatedPath?.expression !== null && generatedPath?.expression !== undefined) {
            setSelectedExpression(generatedPath.expression);
            onSelectPath(generatedPath.expression);
          }
        }}
      >
        <span className="api-source-json-tree__disclosure" aria-hidden="true">
          {branch ? <Icon name="collapse" className="api-source-json-tree__icon" /> : null}
        </span>
        <span className="api-source-json-tree__key">{itemLabel}</span>
        <span className="api-source-json-tree__type">{nodeTypeLabel(node.value, messages)}</span>
        {displayPreview.length === 0 ? null : <code className="api-source-json-tree__value mono">{displayPreview}</code>}
      </div>
      {branch && isExpanded ? <div role="group" className="api-source-json-tree__children">
        {entries.map(([key, child]) => {
          const segment: PathSegment = Array.isArray(node.value) ? Number(key) : key;
          const childPath = [...node.path, segment];
          return renderNode({
            id: pathId(childPath),
            key: Array.isArray(node.value) ? `[${key}]` : key,
            path: childPath,
            value: child,
          });
        })}
        {childCount > maximumVisibleEntries ? <div className="api-source-json-tree__item api-source-json-tree__item--more" role="treeitem" aria-disabled="true" tabIndex={-1}>
            <span className="api-source-json-tree__disclosure" aria-hidden="true" />
            <span className="api-source-json-tree__key">{messages.moreEntries(childCount - maximumVisibleEntries)}</span>
          </div> : null}
      </div> : null}
    </div>;
  };

  const placeholder = value === undefined;
  const root = placeholder
    ? <div className="api-source-json-tree__item api-source-json-tree__item--placeholder" role="treeitem" tabIndex={0} aria-label={loading ? messages.loading : messages.empty} data-tree-node-id={rootId}>
      <span className="api-source-json-tree__disclosure" aria-hidden="true" />
      <span className="api-source-json-tree__key">{loading ? messages.loading : messages.empty}</span>
    </div>
    : renderNode({ id: rootId, key: messages.responseRoot, path: rootPath, value }, true);

  return <div className="api-source-json-tree" role="tree" aria-label={messages.treeLabel} data-testid="api-source-json-tree">
    {root}
  </div>;
}
