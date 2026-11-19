// probe: dump settings.model from createSession (read-only vs daemon)
import { connectDaemon } from "../src/serve/daemon.ts";
import { ServeSession } from "../src/serve/session.ts";

const daemon = await connectDaemon(process.env, () => {});
const events = { onConversationFrame: () => {}, onLifecycle: () => {}, onRequest: async () => ({}) };
const s = new ServeSession(daemon, process.cwd(), events);
const created = await s.createSession();
const settings = created.raw?.settings;
console.log(JSON.stringify(settings?.model, null, 1).slice(0, 4000));
process.exit(0);
