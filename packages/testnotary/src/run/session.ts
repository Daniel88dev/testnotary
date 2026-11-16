// Agent detection lives in the core package (`SESSION_AGENTS`, `detectSession`), so the docs list
// the same table the library reads. `prepareRun` fills `notes.session` with it on every run.
export { detectSession, type SessionLabels } from "../shared.ts";
