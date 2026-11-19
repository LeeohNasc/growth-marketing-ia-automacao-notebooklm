/** Log estruturado em JSON. Nunca registra tokens, chaves ou URLs assinadas. */
type Level = "debug" | "info" | "warn" | "error";

const SECRET_KEYS = /token|secret|key|authorization|password|signed/i;

function sanitize(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SECRET_KEYS.test(k)) out[k] = "[redacted]";
    else if (typeof v === "string") out[k] = v.replace(/([?&](token|X-Amz-Signature)=)[^&\s]+/gi, "$1[redacted]").slice(0, 2000);
    else out[k] = v;
  }
  return out;
}

export type Logger = Record<Level, (msg: string, fields?: Record<string, unknown>) => void>;

export function createLogger(base: Record<string, unknown> = {}, sink: (line: string) => void = (l) => process.stdout.write(l + "\n")): Logger {
  const emit = (level: Level) => (msg: string, fields: Record<string, unknown> = {}) =>
    sink(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...sanitize({ ...base, ...fields }) }));
  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}

export const silentLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
