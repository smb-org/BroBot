import { useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

import { DashboardDataProvider } from "../../src/dashboard/data/provider";
import { Shell } from "../../src/dashboard/ui/Shell";
import { Sidebar, type SidebarGroup } from "../../src/dashboard/ui/Sidebar";
import { StatusLed } from "../../src/dashboard/ui/StatusLed";
import { UiProvider } from "../../src/dashboard/ui/Provider";
import { Icon } from "../../src/dashboard/ui/Icon";
import { NavigationIcon } from "../../src/dashboard/ui/NavigationIcon";
import { Select as UiSelect } from "../../src/dashboard/ui/Select";
import FaqPanel from "../../src/modules/faq/panel";
import "../../src/dashboard/styles.css";

const sidebarGroups: SidebarGroup[] = [
  {
    id: "chat",
    category: "chat",
    heading: "CHAT",
    entries: [
      { id: "commands", category: "chat", label: "Textbefehle", icon: <NavigationIcon kind="commands" />, href: "#commands", active: false, onNavigate: () => undefined },
      { id: "faq", category: "chat", label: "FAQ & Auto-Antworten", icon: <NavigationIcon kind="faq" />, href: "#faq", active: true, onNavigate: () => undefined },
      { id: "texts", category: "chat", label: "Textbausteine", icon: <NavigationIcon kind="texts" />, href: "#texts", active: false, onNavigate: () => undefined },
      { id: "timers", category: "chat", label: "Timer", icon: <NavigationIcon kind="timers" />, href: "#timers", active: false, onNavigate: () => undefined },
    ],
  },
  {
    id: "participation",
    category: "participation",
    heading: "MITMACHEN",
    entries: [
      { id: "voting", category: "participation", label: "Abstimmung", icon: <NavigationIcon kind="voting" />, href: "#voting", active: false, onNavigate: () => undefined },
      { id: "votekick", category: "participation", label: "Votekick", icon: <NavigationIcon kind="votekick" />, href: "#votekick", active: false, onNavigate: () => undefined },
      { id: "clips", category: "participation", label: "Clips", icon: <NavigationIcon kind="clips" />, href: "#clips", active: false, onNavigate: () => undefined },
    ],
  },
  {
    id: "twitch",
    category: "twitch",
    heading: "TWITCH",
    entries: [
      { id: "ads", category: "twitch", label: "Werbung", icon: <NavigationIcon kind="ads" />, href: "#ads", active: false, onNavigate: () => undefined },
      { id: "raid", category: "twitch", label: "Raid & Shoutout", icon: <NavigationIcon kind="raid" />, href: "#raid", active: false, onNavigate: () => undefined },
    ],
  },
  {
    id: "data",
    category: "data",
    heading: "DATEN",
    entries: [
      { id: "weather", category: "data", label: "Ort & Wetter", icon: <NavigationIcon kind="weather" />, href: "#weather", active: false, onNavigate: () => undefined },
      { id: "sources", category: "data", label: "Eigene Datenquellen", icon: <NavigationIcon kind="data" />, href: "#sources", active: false, onNavigate: () => undefined },
    ],
  },
  {
    id: "stream",
    category: "stream",
    heading: "STREAM",
    entries: [
      { id: "overlays", category: "stream", label: "Overlays", icon: <NavigationIcon kind="overlays" />, href: "#overlays", active: false, onNavigate: () => undefined },
      { id: "belabox", category: "stream", label: "BELABOX", icon: <NavigationIcon kind="belabox" />, href: "#belabox", active: false, onNavigate: () => undefined },
    ],
  },
  {
    id: "admin",
    category: "admin",
    heading: "VERWALTUNG",
    entries: [
      { id: "modules", category: "admin", label: "Module an/aus", icon: <NavigationIcon kind="modules" />, href: "#modules", active: false, onNavigate: () => undefined },
      { id: "members", category: "admin", label: "Mitglieder & Rechte", icon: <NavigationIcon kind="members" />, href: "#members", active: false, onNavigate: () => undefined },
      { id: "variables", category: "admin", label: "Variablen", icon: <NavigationIcon kind="variable" />, href: "#variables", active: false, onNavigate: () => undefined },
      { id: "events", category: "admin", label: "Kanalereignisse", icon: <NavigationIcon kind="events" />, href: "#events", active: false, onNavigate: () => undefined },
      { id: "audit", category: "admin", label: "Protokoll", icon: <NavigationIcon kind="audit" />, href: "#audit", active: false, onNavigate: () => undefined },
      { id: "system", category: "admin", label: "System", icon: <NavigationIcon kind="system" />, href: "#system", active: false, onNavigate: () => undefined },
    ],
  },
];

export function CaptureHeader(): ReactElement {
  return (
    <div className="dashboard-header">
      <div className="dashboard-header__start">
        <a className="brand-mark dashboard-header__brand" href="#dashboard"><span className="brand-mark__dot" /><span className="brand-mark__word">BroBot</span></a>
        <div className="dashboard-header__channel">
          <div className="dashboard-header__channel-select">
            <span aria-hidden="true" className="dashboard-header__channel-avatar">K</span>
            <UiSelect
              ariaLabel="Kanal auswählen"
              compact
              value="channel-a"
              onChange={() => undefined}
              options={[{ value: "channel-a", label: "Kanal Demo — kanal_demo", selectedLabel: "kanal_demo" }]}
            />
          </div>
        </div>
      </div>
      <div aria-label="Bereich" className="dashboard-header__mode" role="group">
        <button type="button" aria-pressed="false"><Icon name="broadcast" size={16} /><span className="dashboard-header__mode-label">Live</span></button>
        <button type="button" aria-pressed="true"><Icon name="tabSettings" size={16} /><span className="dashboard-header__mode-label">Einrichten</span></button>
      </div>
      <div className="dashboard-header__end">
        <div className="dashboard-header__status"><StatusLed state="ok" label="Bereit" /></div>
        <button aria-label="Suchen" className="dashboard-header__palette-trigger" type="button"><Icon name="search" size={16} /><span>Suchen</span><kbd>⌘ K</kbd></button>
        <button aria-label="Demo-Konto" className="dashboard-header__account-trigger" type="button"><span aria-hidden="true" className="dashboard-header__account-avatar">D</span><span className="dashboard-header__account-name">Demo-Konto</span><span aria-hidden="true">⌄</span></button>
      </div>
    </div>
  );
}

export function FaqDashboardFixture(): ReactElement {
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  return (
    <DashboardDataProvider>
      <UiProvider>
        <Shell
          header={() => <CaptureHeader />}
          navbar={(context) => <Sidebar
            groups={sidebarGroups}
            onOpenCommandPalette={context.openCommandPalette}
            onEntryNavigate={context.closeMobileNav}
            setupHeading="Einrichten"
            setupDescription="Alles für deinen Stream."
            paletteLabel="Alles durchsuchen"
            paletteShortcut="⌘ K"
          />}
          navLabel="Hauptnavigation"
          openSidebarLabel="Seitenleiste öffnen"
          closeSidebarLabel="Seitenleiste schließen"
          mode="setup"
          commandPaletteOpen={commandPaletteOpen}
          onCommandPaletteOpenChange={setCommandPaletteOpen}
        >
          <main className="main-content" style={{ boxSizing: "border-box", display: "flex", flexDirection: "column", width: "100%", maxWidth: "none", height: "calc(100dvh - 64px)", padding: "24px 32px" }}>
            <FaqPanel channelId="channel-a" language="de" />
          </main>
        </Shell>
      </UiProvider>
    </DashboardDataProvider>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<FaqDashboardFixture />);
