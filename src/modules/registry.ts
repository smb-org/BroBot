import type { BotModule } from "./contract";
import { channelEventsModule } from "./channel_events";
import { raidModule } from "./raid";
import { textCommandModule } from "./text_commands";
import { adsModule } from "./ads";

// Dies ist die einzige Stelle, die alle Module kennt.
export const MODULES: readonly BotModule[] = [textCommandModule, channelEventsModule, adsModule, raidModule];
