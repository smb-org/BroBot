// The seam: everything a panel is allowed to import from `@mantine/*` comes
// through here, in project vocabulary. See "Die Naht `src/dashboard/ui/`"
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

export { NumberField } from "./NumberField";
export type { NumberFieldProps } from "./NumberField";

export { Select } from "./Select";
export type { SelectProps, SelectOption } from "./Select";

export { Switch } from "./Switch";
export type { SwitchProps } from "./Switch";

export { Button } from "./Button";
export type { ButtonProps, ButtonVariant } from "./Button";

export { Led } from "./Led";
export type { LedProps, LedStatus } from "./Led";

export { Chip } from "./Chip";
export type { ChipProps, ChipTone } from "./Chip";

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

export { InspectorHeading, SubInspector } from "./Inspector";

export { useInspectorSelection } from "./inspector-selection";

export { useDraft } from "./useDraft";
export type { UseDraftResult } from "./useDraft";

export { useDraftGuard } from "./useDraftGuard";
export type { UseDraftGuardResult } from "./useDraftGuard";

export { ListDetail } from "./ListDetail";
export type { ListDetailProps } from "./ListDetail";
