import type { BotModule } from "./contract";
import { channelEventsModule } from "./channel_events";
import { raidModule } from "./raid";
import { textCommandModule } from "./text_commands";
import { adsModule } from "./ads";

// This is the only place that knows all modules.
export const MODULES: readonly BotModule[] = [textCommandModule, channelEventsModule, adsModule, raidModule];
