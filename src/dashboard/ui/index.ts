// The seam: everything a panel is allowed to import from `@mantine/*` comes
// through here, in project vocabulary. See "The seam `src/dashboard/ui/`"
// in docs/input/DESIGN-neu.md.

export { UiProvider } from "./Provider";
export { Tabs } from "@mantine/core";
export { Dialog } from "./Dialog";
export { Shell } from "./Shell";
export { NavigationIcon } from "./NavigationIcon";
export { PageHeader } from "./PageHeader";
export { FilterBar } from "./FilterBar";
export { ListToolbar } from "./ListToolbar";
export { EmptyCellValue } from "./EmptyCellValue";
export { AuditSentence } from "./AuditSentence";
export { Badge } from "./Badge";
export { InspectorSection, InspectorFieldRow, InspectorActions } from "./InspectorParts";
export { ActionMenu } from "./ActionMenu";
export { ChatOutputTargetControl } from "./ChatOutputTargetControl";

export { Sidebar } from "./Sidebar";
export type { SidebarEntry, SidebarGroup } from "./Sidebar";

export { Field } from "./Field";
export { ChannelLocationMenu } from "./ChannelLocationMenu";
export { GamePicker, type GamePickerGame, type GamePickerMessages } from "./GamePicker";
export { ColorField } from "./ColorField";
export { CodeField } from "./CodeField";
export { GroupedPicker } from "./GroupedPicker";
export type { GroupedPickerEntry, GroupedPickerGroup, GroupedPickerMessages } from "./GroupedPicker";
export { FieldPair } from "./FieldPair";
export { TimeoutDurationRangeFields } from "./TimeoutDurationRangeFields";
export { SegmentedControl } from "./SegmentedControl";
export { ChoiceCards } from "./ChoiceCards";
export { TagInput } from "./TagInput";
export type { TagInputMessages } from "./TagInput";
export { TextArea } from "./TextArea";
export type { TemplateVariableOption, TextAreaMessages } from "./TextArea";

export {
  effectivePanelTemplateVariables,
  panelTemplateOptions,
  registeredTemplatePickerGroup,
} from "./template-variable-options";
export type { TemplateVariablePickerMessages } from "./TemplateVariablePicker";

export { TemplateText } from "./TemplateText";
export { ChatPreview } from "./ChatPreview";
export { EditorShell } from "./EditorShell";
export type { EditorInvalidField, EditorSection } from "./EditorShell";
export { SettingsEditor } from "./SettingsEditor";
export { textFieldLength } from "./text-length";
export type {
  SettingsEditorCatalog,
  SettingsEditorDefinition,
  SettingsEditorSpec,
  SettingsFieldSpec,
} from "./SettingsEditor";
export { NumberField } from "./NumberField";
export { Select } from "./Select";
export type { SelectOption } from "./Select";
export { Switch } from "./Switch";
export { Button } from "./Button";
export { FormDialog } from "./FormDialog";
export { FormDensity } from "./FormDensity";
export { Icon } from "./Icon";
export type { IconName } from "./Icon";
export { Led } from "./Led";
export { ChipGroup } from "./ChipGroup";
export { ConfirmDialog } from "./ConfirmDialog";
export { Popover } from "./Popover";
export { ControlDurationDialog } from "./ControlDurationDialog";
export { SaveBar } from "./SaveBar";
export { Skeleton } from "./Skeleton";
export { LoadState } from "./LoadState";
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
