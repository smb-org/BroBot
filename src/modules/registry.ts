import type { BotModule } from "./contract";
import { kanalereignisseModul } from "./channel_events";
import { raidModul } from "./raid";
import { textbefehlModul } from "./text_commands";
import { werbungModul } from "./ads";

// Dies ist die einzige Stelle, die alle Module kennt.
export const MODULES: readonly BotModule[] = [textbefehlModul, kanalereignisseModul, werbungModul, raidModul];
