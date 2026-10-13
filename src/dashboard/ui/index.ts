// The seam: everything a panel is allowed to import from `@mantine/*` comes
// through here, in project vocabulary. See "The seam `src/dashboard/ui/`"
// in docs/input/DESIGN-neu.md.

export { UiProvider } from "./Provider";
export { Tabs } from "@mantine/core";
export { Dialog } from "./Dialog";
export { Shell } from "./Shell";
export { NavigationIcon } from "./NavigationIcon";
export { PageHeader } from "./PageHeader";
export { CollectionPage } from "./CollectionPage";
export { SettingsPage } from "./SettingsPage";
export { ToolPage } from "./ToolPage";
export { ChatCommandsHelp } from "../ChatCommandsHelp";
export { FilterBar } from "./FilterBar";
export { ListToolbar } from "./ListToolbar";
export { EmptyCellValue } from "./EmptyCellValue";
export { AuditSentence } from "./AuditSentence";
export { Badge } from "./Badge";
export { InspectorSection, InspectorFieldRow, InspectorActions } from "./InspectorParts";
export { Section } from "./Section";
export { ActionMenu } from "./ActionMenu";
export { ChatTargetField } from "./ChatTargetField";

export { Sidebar } from "./Sidebar";
export type { SidebarEntry, SidebarGroup } from "./Sidebar";

export { Field } from "./Field";
export { ChannelLocationMenu } from "./ChannelLocationMenu";
export { GameMultiSelect, type GameMultiSelectGame, type GameMultiSelectMessages } from "./GameMultiSelect";
export { ColorField } from "./ColorField";
export { CodeField } from "./CodeField";
export { InlineSuggestionPicker, InlineSuggestionPickerTarget } from "./InlineSuggestionPicker";
export type { InlineSuggestionGroup, InlineSuggestionGroupPresentation, InlineSuggestionPickerMessages } from "./InlineSuggestionPicker";
export { Textarea } from "./primitives/textarea";
export { GroupedPicker } from "./GroupedPicker";
export type { GroupedPickerEntry, GroupedPickerGroup, GroupedPickerMessages } from "./GroupedPicker";
export { FieldPair } from "./FieldPair";
export { TimeoutDurationRangeFields } from "./TimeoutDurationRangeFields";
export { SegmentChoice } from "./SegmentChoice";
export { ChoiceCards } from "./ChoiceCards";
export { ChipsInput } from "./ChipsInput";
export type { ChipsInputMessages } from "./ChipsInput";
export { TemplateTextField } from "./TemplateTextField";
export type { TemplateTextFieldMessages, TemplateTextFieldVariable } from "./TemplateTextField";

export {
  effectivePanelTemplateVariables,
  panelTemplateOptions,
  registeredModuleTemplateGroup,
} from "./template-variable-options";
export type { TemplateTextFieldPickerMessages } from "./template-text-field-model";

export { TemplateText } from "./TemplateText";
export { ChatPreview } from "./ChatPreview";
export { TokenChip } from "./TokenChip";
export { EditorShell } from "./EditorShell";
export type { EditorInvalidField, EditorSection } from "./EditorShell";
export { SettingsEditor } from "./SettingsEditor";
export { mapServerFieldErrors } from "./server-field-errors";
export { UnitInput } from "./UnitInput";
export { textFieldLength } from "./text-length";
export type {
  SettingsEditorCatalog,
  SettingsEditorDefinition,
  SettingsEditorSpec,
  SettingsFieldSpec,
} from "./SettingsEditor";
export { Select } from "./Select";
export type { SelectOption } from "./Select";
export { SwitchRow } from "./SwitchRow";
export { SwitchSection } from "./SwitchSection";
export { RoleThreshold } from "./RoleThreshold";
export { FieldError } from "./FieldError";
export { LockedReason } from "./LockedReason";
export { RuleNote } from "./RuleNote";
export { Button } from "./Button";
export { FormDialog } from "./FormDialog";
export { FormDensity } from "./FormDensity";
export { Icon } from "./Icon";
export { StatusLed } from "./StatusLed";
export type { StatusLedState } from "./StatusLed";
export type { IconName } from "./Icon";
export { ChipGroup } from "./ChipGroup";
export { ConfirmDialog } from "./ConfirmDialog";
export { Popover } from "./Popover";
export { ControlDurationDialog } from "./ControlDurationDialog";
export { SaveStatus } from "./SaveStatus";
export { LoadState, LoadStateLines } from "./LoadState";
export type { QueryError } from "./LoadState";
export { notify } from "./toast-store";
export { EmptyState } from "./EmptyState";
export { BlockingState } from "./BlockingState";
export { InspectorHeading, SubInspector } from "./Inspector";
export { useInspectorSelection } from "./inspector-selection";
export { useDraft } from "./useDraft";
export { useDraftGuard } from "./useDraftGuard";
export { registerDashboardNavigationGuard } from "./navigation-guard";
export { ListDetail } from "./ListDetail";
export { ListPaginationFooter } from "./ListPaginationFooter";
export { ListRow } from "./ListRow";
export { Spotlight } from "./Spotlight";
export type { SpotlightItem } from "./Spotlight";
export { DataTable } from "./DataTable";
export { formatRelativeTime } from "./format-relative-time";
export { StepDialog } from "./StepDialog";
