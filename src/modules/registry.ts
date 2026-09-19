import type { BotModule } from "./contract";
import { textbefehlModul } from "./textbefehle";

// Dies ist die einzige Stelle, die alle Module kennt.
export const MODULES: readonly BotModule[] = [textbefehlModul];
