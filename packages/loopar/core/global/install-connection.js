import { DEFAULT_PORTS } from "db-env";

/**
 * The db.config a wizard submission describes: `{ dialect, connection }` from
 * the "Database" step fields (db_*), or null when the submission carries no
 * engine (programmatic installs keep the db.config already on disk).
 * The connection is built fresh, never merged into the previous one, so
 * switching engines leaves no fields of the old engine behind.
 */
export function connectionFromInstallData(data = {}) {
  const dialect = String(data.db_dialect || "").trim().toLowerCase();
  if (!dialect) return null;
  if (dialect === "sqlite") return { dialect, connection: {} };

  const connection = {
    host: String(data.db_host || "").trim() || "localhost",
    port: String(data.db_port || "").trim() || DEFAULT_PORTS[dialect] || "",
    user: String(data.db_user || "").trim(),
    password: data.db_password ?? "",
  };
  return { dialect, connection };
}
