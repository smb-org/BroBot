// The seam: everything a panel is allowed to import from `@mantine/*` comes
// through here, in project vocabulary. See "The seam `src/dashboard/ui/`"
// in docs/input/DESIGN-neu.md.

export { UiProvider } from "./Provider";
export { theme, colors, luminanceThreshold } from "./theme";
export type { StateToken, FamilyToken } from "./theme";

export { Stack, Group, Grid } from "./Layout";

export { Shell } from "./Shell";
export type { ShellProps, ShellNavContext } from "./Shell";

export { Sidebar } from "./Sidebar";
export type { SidebarProps, SidebarEntry, SidebarGroup, SidebarModulesGroup } from "./Sidebar";

export { Field } from "./Field";
export type { FieldProps } from "./Field";

export { FieldPair } from "./FieldPair";
export type { FieldPairProps } from "./FieldPair";

export { SegmentedControl } from "./SegmentedControl";
export type { SegmentedControlOption, SegmentedControlProps } from "./SegmentedControl";

export { ChoiceCards } from "./ChoiceCards";
export type { ChoiceCardOption, ChoiceCardsProps } from "./ChoiceCards";

export { TagInput } from "./TagInput";
export type { TagInputMessages, TagInputProps } from "./TagInput";

export { TextArea } from "./TextArea";
export type { TemplateVariableOption, TextAreaMessages, TextAreaProps } from "./TextArea";

export { TemplateText } from "./TemplateText";
export type { TemplateTextProps } from "./TemplateText";

export { ChatPreview } from "./ChatPreview";
export type { ChatPreviewProps } from "./ChatPreview";

export { EditorShell } from "./EditorShell";
export type { EditorSection, EditorShellProps } from "./EditorShell";

export { SettingsEditor } from "./SettingsEditor";
export type { SettingsEditorCatalog, SettingsEditorDefinition, SettingsEditorProps, SettingsEditorSpec, SettingsEditorTexts, SettingsFieldSpec, SettingsFieldText } from "./SettingsEditor";

export { NumberField } from "./NumberField";
export type { NumberFieldProps } from "./NumberField";

export { Select } from "./Select";
export type { SelectProps, SelectOption } from "./Select";

export { Switch } from "./Switch";
export type { SwitchProps } from "./Switch";

export { Button } from "./Button";
export type { ButtonProps, ButtonSize, ButtonVariant } from "./Button";
export { FormDensity } from "./FormDensity";

export { Icon } from "./Icon";
export type { IconName } from "./Icon";

export { Led } from "./Led";
export type { LedProps, LedStatus } from "./Led";

export { Chip } from "./Chip";
export type { ChipProps, ChipTone } from "./Chip";

export { ChipGroup } from "./ChipGroup";
export type { ChipGroupOption, ChipGroupProps } from "./ChipGroup";

export { ConfirmDialog } from "./ConfirmDialog";
export type { ConfirmDialogProps } from "./ConfirmDialog";

export { SaveBar } from "./SaveBar";
export type { SaveBarProps } from "./SaveBar";

export { Skeleton } from "./Skeleton";
export type { SkeletonProps } from "./Skeleton";

export { EmptyState } from "./EmptyState";
export type { EmptyStateProps, EmptyStateAction } from "./EmptyState";

export { ErrorPanel } from "./ErrorPanel";
export type { ErrorPanelProps, ErrorPanelAction } from "./ErrorPanel";

export { BlockingState } from "./BlockingState";
export type { BlockingStateProps, BlockingStateAction } from "./BlockingState";

export { InspectorHeading, SubInspector } from "./Inspector";

export { useInspectorSelection } from "./inspector-selection";

export { useDraft } from "./useDraft";
export type { UseDraftResult } from "./useDraft";

export { useDraftGuard } from "./useDraftGuard";
export type { UseDraftGuardResult } from "./useDraftGuard";

export { ListDetail } from "./ListDetail";
export type { ListDetailProps } from "./ListDetail";

export { ListRow } from "./ListRow";
export type { ListRowProps } from "./ListRow";

export { Spotlight } from "./Spotlight";
export type { SpotlightItem, SpotlightProps } from "./Spotlight";
