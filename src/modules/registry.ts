import type { BotModule } from "./contract";
import { kanalereignisseModul } from "./kanalereignisse";
import { raidModul } from "./raid";
import { textbefehlModul } from "./textbefehle";
import { werbungModul } from "./werbung";

// Dies ist die einzige Stelle, die alle Module kennt.
export const MODULES: readonly BotModule[] = [textbefehlModul, kanalereignisseModul, werbungModul, raidModul];
