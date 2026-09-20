import type { BotModule } from "./contract";
import { kanalereignisseModul } from "./kanalereignisse";
import { textbefehlModul } from "./textbefehle";

// Dies ist die einzige Stelle, die alle Module kennt.
export const MODULES: readonly BotModule[] = [textbefehlModul, kanalereignisseModul];
