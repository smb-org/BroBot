import { app, workerFetch } from "./worker-app";
import { scheduled } from "./scheduled";

export { ChannelObject } from "./durable/ChannelObject";
export { app };

export default {
  fetch: workerFetch,
  scheduled,
} satisfies ExportedHandler<Env>;
