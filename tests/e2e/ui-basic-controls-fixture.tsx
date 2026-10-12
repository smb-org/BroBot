import { createRoot } from "react-dom/client";
import { useState } from "react";

import { ActionMenu, Button, Dialog, Popover, Select, SegmentChoice, StatusLed, Switch, UiProvider, UnitInput } from "../../src/dashboard/ui";
import "../../src/dashboard/ui/tokens.css";

export function BasicControlsFixture() {
  const [number, setNumber] = useState<number | "">(4);
  const [mode, setMode] = useState("one");
  const [enabled, setEnabled] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  return <UiProvider>
    <main className="main-content" style={{ width: "min(720px, 100%)", padding: 16 }}>
      <div className="e2e-layout-anchor" style={{ display: "grid", gap: 12, width: 320 }}>
        <Button size="compact">Primary action</Button>
        <UnitInput label="Duration" value={number} onChange={setNumber} unit="s" min={0} max={60} />
        <Select label="Mode" value={mode} onChange={(next) => setMode(next ?? "one")} options={[{ value: "one", label: "One" }, { value: "two", label: "Two" }]} />
        <Select label="Search mode" value="one" onChange={() => {}} searchable options={[{ value: "one", label: "One" }, { value: "two", label: "Two" }]} />
        <SegmentChoice label="Layout" value={mode} onChange={setMode} options={[{ value: "one", label: "One" }, { value: "two", label: "Two" }]} />
        <Switch layout="inline" label="Enabled" checked={enabled} onChange={setEnabled} />
        <Popover triggerLabel="Popover help" icon="warning">A short help message.</Popover>
        <ActionMenu label="More actions" items={[{ label: "Edit settings", onSelect: () => {} }]} />
        <Button size="compact" onClick={() => { setDialogOpen(true); }}>Open dialog</Button>
      </div>
      <StatusLed state="ok" label="Connected" />
    </main>
    <Dialog opened={dialogOpen} title="Control dialog" onClose={() => { setDialogOpen(false); }}>
      <p>Dialog content.</p>
    </Dialog>
  </UiProvider>;
}

createRoot(document.getElementById("root") as HTMLElement).render(<BasicControlsFixture />);
