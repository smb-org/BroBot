import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { createContext, useContext, useState, type ComponentProps, type ReactElement, type ReactNode } from "react";

interface TabsContextValue {
  keepMounted: boolean;
  value: string | null;
}

const TabsContext = createContext<TabsContextValue>({ keepMounted: false, value: null });

interface TabsRootProps extends Omit<ComponentProps<typeof TabsPrimitive.Root>, "onValueChange" | "onChange" | "value" | "defaultValue"> {
  children: ReactNode;
  keepMounted?: boolean;
  onChange?: (value: string | null) => void;
  value?: string | null;
  defaultValue?: string | null;
}

interface TabsPanelProps extends ComponentProps<"div"> {
  value: string;
  keepMounted?: boolean;
}

export function TabsRoot({ children, keepMounted = false, onChange, value, defaultValue, ...props }: TabsRootProps): ReactElement {
  const [internalValue, setInternalValue] = useState<string | null>(defaultValue ?? null);
  const activeValue = value !== undefined ? value : internalValue;

  return <TabsContext.Provider value={{ keepMounted, value: activeValue }}>
    <TabsPrimitive.Root {...props} value={value ?? undefined} defaultValue={defaultValue ?? undefined} onValueChange={(nextValue: unknown) => {
      const next = typeof nextValue === "string" ? nextValue : null;
      if (value === undefined) setInternalValue(next);
      onChange?.(next);
    }}>{children}</TabsPrimitive.Root>
  </TabsContext.Provider>;
}

export function TabsPanel({ children, value, keepMounted: panelKeepMounted, ...props }: TabsPanelProps): ReactElement {
  const { keepMounted, value: activeValue } = useContext(TabsContext);
  const shouldRender = keepMounted || panelKeepMounted === true || activeValue === value;
  return <TabsPrimitive.Panel {...props} value={value} keepMounted={keepMounted || panelKeepMounted}>{shouldRender ? children : null}</TabsPrimitive.Panel>;
}
