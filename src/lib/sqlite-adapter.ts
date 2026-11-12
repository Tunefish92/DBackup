import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

/** How long a query waits for a lock of another writer before SQLite answers "database is locked". */
export const SQLITE_BUSY_TIMEOUT_MS = 5000;

/**
 * The SQLite file of a `file:` URL like DATABASE_URL. A relative one is resolved against the folder
 * of schema.prisma, where Prisma 6 found it, so existing setups keep their database. Parameters
 * like the old `?connection_limit=1` are dropped, since the driver would read them as part of the name.
 */
export function sqliteFileOf(url: string, cwd: string = process.cwd()): string {
    const file = url.replace(/^file:/, "").split("?")[0];
    if (file === ":memory:" || path.isAbsolute(file)) {
        return file;
    }
    return path.resolve(cwd, "prisma", file);
}

/**
 * The driver of Prisma for a SQLite file. Dates are written as milliseconds since 1970, the way
 * Prisma 6 wrote every date DBackup holds, so old and new rows compare and sort alike.
 */
export function sqliteAdapterFor(url: string): PrismaBetterSqlite3 {
    return new PrismaBetterSqlite3({ url: sqliteFileOf(url), timeout: SQLITE_BUSY_TIMEOUT_MS }, { timestampFormat: "unixepoch-ms" });
}
