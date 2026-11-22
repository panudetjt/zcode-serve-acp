import { connectDaemon } from "../src/serve/daemon.ts"
import { ServeSession } from "../src/serve/session.ts"
const daemon = await connectDaemon(process.env, () => {})
const s = new ServeSession(daemon, process.cwd(), {
  onConversationFrame: () => {},
  onLifecycle: () => {},
  onRequest: async () => ({})
})
const created = await s.createSession()
const raw = created.raw
console.log("session keys:", Object.keys(raw?.session ?? {}))
console.log("runtime keys:", Object.keys(raw?.runtime ?? {}))
console.log("session json:", JSON.stringify(raw?.session, null, 1).slice(0, 700))
console.log("settings json:", JSON.stringify(raw?.settings, null, 1).slice(0, 500))
process.exit(0)
