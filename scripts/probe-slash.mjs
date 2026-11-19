import { connectDaemon } from "../src/serve/daemon.ts";
import { ServeSession } from "../src/serve/session.ts";
const daemon = await connectDaemon(process.env, () => {});
const s = new ServeSession(daemon, process.cwd(), {
  onConversationFrame: () => {},
  onLifecycle: () => {},
  onRequest: async () => ({}),
});
const created = await s.createSession();
const sc = created.raw?.slashCommands;
console.log("slashCommands type:", Array.isArray(sc) ? `array[${sc.length}]` : typeof sc);
console.log(JSON.stringify(sc, null, 1).slice(0, 1200));
process.exit(0);
