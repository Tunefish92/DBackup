import type { ExecutionHost } from "@/lib/transport";
import type { BackupResult } from "@/lib/core/interfaces";
import type { LogLevel, LogType } from "@/lib/core/logs";
import type { OracleConfig } from "@/lib/adapters/definitions";
import { formatBytes } from "@/lib/utils";
import { queryRows, withConnection, type OracleConnection } from "./connection";
import { excerpt, keptObject, logDetails, reviewLog, runImport, type JobFiles } from "./datapump";
import { probeDirectory, readTextTail, removeRemoteFile, uploadFile } from "./files";
import { assertSchemaName, directoryName, newSchemaName, runNames } from "./identifiers";
import { listInvalid, recompileSchema } from "./recompile";

type OnLog = (msg: string, level?: LogLevel, type?: LogType, details?: string) => void;
type OnProgress = (percentage: number, detail?: string) => void;

/** Extra fields the restore pipeline sets on the config of the target. */
type OracleRestoreConfig = OracleConfig & {
    targetDatabaseName?: string;
    databaseMapping?: { originalName: string; targetName: string; selected: boolean }[];
};

/**
 * Restoring one schema: the dump copied over the connection into the directory object, a Data
 * Pump import, a recompile of what it left invalid, then both files removed from the server.
 *
 * The import replaces tables that exist and creates what is missing, including the user when
 * the backup was taken by a login with DATAPUMP_EXP_FULL_DATABASE. Other objects that already
 * exist, like sequences or procedures, are kept and reported. A restore under a new name gives
 * an exact copy.
 */

/** Uploading takes this share of the progress bar, the import the rest. */
const UPLOAD_SHARE = 80;

interface SchemaRow {
    USERNAME: string;
    ORACLE_MAINTAINED: string;
}

async function findSchema(connection: OracleConnection, name: string): Promise<SchemaRow | undefined> {
    const rows = await queryRows<SchemaRow>(
        connection,
        `SELECT username, oracle_maintained FROM all_users WHERE username = :p_schema`,
        { p_schema: name },
    );
    return rows[0];
}

/**
 * The schema a restore writes into. An existing schema is taken by its exact name. A new one
 * typed in lower case becomes upper case, see newSchemaName(). Oracle's own schemas are refused.
 */
export async function resolveTarget(connection: OracleConnection, requested: string): Promise<{ name: string; exists: boolean }> {
    assertSchemaName(requested);
    let name = requested;
    let row = await findSchema(connection, requested);
    if (!row) {
        name = newSchemaName(requested);
        if (name !== requested) row = await findSchema(connection, name);
    }
    if (row?.ORACLE_MAINTAINED === "Y") {
        throw new Error(`Schema ${name} belongs to Oracle itself. Restore into a schema of your own.`);
    }
    return { name, exists: !!row };
}

/**
 * Imports the dump at `filePath` into `target`. `source` is the schema the dump was taken of.
 */
export async function importSchema(
    connection: OracleConnection,
    config: OracleConfig,
    filePath: string,
    target: string,
    source: string,
    onLog: OnLog,
    onProgress?: OnProgress,
): Promise<string> {
    assertSchemaName(source);
    const directory = directoryName(config.directory);
    const resolved = await resolveTarget(connection, target);
    if (resolved.name !== target) {
        onLog(`Restoring into schema ${resolved.name}, the name ${target} as Oracle stores it`);
    }
    const names = runNames("IMP");
    const files: JobFiles = { job: names.job, directory, dumpFile: names.dumpFile, logFile: names.logFile };

    try {
        const started = Date.now();
        const size = await uploadFile(connection, filePath, directory, files.dumpFile, (bytes, total) => {
            if (!onProgress || total <= 0) return;
            const seconds = Math.max((Date.now() - started) / 1000, 0.001);
            const percent = Math.min(UPLOAD_SHARE, Math.round((bytes / total) * UPLOAD_SHARE));
            onProgress(percent, `${formatBytes(bytes)} / ${formatBytes(total)} - ${formatBytes(bytes / seconds)}/s`);
        });
        onLog(`Copied the dump to the server: ${formatBytes(size)}`);

        onProgress?.(UPLOAD_SHARE + 5, "Importing with Data Pump...");
        onLog(
            `Importing schema ${source}${source !== resolved.name ? ` as ${resolved.name}` : ""} with Data Pump`,
            "info",
            "command",
            `DBMS_DATAPUMP import, job ${files.job}, ${source !== resolved.name ? `REMAP_SCHEMA ${source}:${resolved.name}, ` : ""}TABLE_EXISTS_ACTION=REPLACE, directory ${directory}`,
        );

        const state = await runImport(connection, files, source, resolved.name);
        const log = await readTextTail(connection, directory, files.logFile).catch(() => "");
        const review = reviewLog(log);

        if (state !== "COMPLETED") {
            throw new Error(`Data Pump import into ${resolved.name} ended as ${state}${review.errors.length ? `:\n${excerpt(review.errors)}` : ""}`);
        }
        if (review.dataLoss.length > 0) {
            throw new Error(`Data Pump could not import all data into ${resolved.name}:\n${excerpt(review.dataLoss)}`);
        }
        const keptObjects = [...new Set(review.kept.map(keptObject))];
        if (keptObjects.length > 0) {
            onLog(`Kept ${keptObjects.length} object(s) that already exist in ${resolved.name}, like sequences, views and procedures`, "info", "general", excerpt(keptObjects, 50));
        }
        if (review.warnings.length > 0) {
            onLog(`Data Pump reported ${review.warnings.length} warning(s) for ${resolved.name}`, "warning", "general", excerpt(review.warnings, 50));
        }
        // Data Pump counts kept objects as errors in its closing line, which reads like a failure,
        // so that line is only shown as it is when something else went wrong.
        const summary = review.warnings.length > 0 ? review.summary : undefined;
        onLog(summary ?? `Data Pump import into ${resolved.name} completed`, "info", "command", logDetails(log));

        const compiled = await recompileSchema(connection, resolved.name);
        if (compiled.failure) {
            onLog(`Could not recompile the objects of ${resolved.name}, Oracle compiles them on their next use`, "warning", "general", compiled.failure);
        }
        if (compiled.invalid.length > 0) {
            onLog(`${compiled.invalid.length} object(s) of ${resolved.name} are still invalid after the restore`, "warning", "general", listInvalid(compiled.invalid));
        } else if (!compiled.failure) {
            onLog(`Recompiled the objects of ${resolved.name}`);
        }
        onProgress?.(100);
        return resolved.name;
    } finally {
        await removeRemoteFile(connection, directory, files.dumpFile);
        await removeRemoteFile(connection, directory, files.logFile);
    }
}

/**
 * Restores a single dump, as written by dumpOne(), into one schema. `originalDbName` is the
 * schema the backup was taken of. Without it the dump is taken to hold the target itself.
 */
export async function restoreOne(
    config: OracleConfig,
    filePath: string,
    targetDbName: string,
    host: ExecutionHost,
    onLog?: OnLog,
    onProgress?: OnProgress,
    originalDbName?: string,
): Promise<void> {
    const log: OnLog = onLog ?? (() => {});
    const source = originalDbName || targetDbName;
    await withConnection(config, host, (connection) => importSchema(connection, config, filePath, targetDbName, source, log, onProgress));
}

/**
 * Checks before a restore starts: the directory works both ways, no target is one of Oracle's
 * own schemas, and a login that restores into a schema other than its own holds the role that
 * allows it.
 */
export async function prepareRestore(config: OracleConfig, databases: string[], host: ExecutionHost): Promise<void> {
    await withConnection(config, host, async (connection) => {
        const directory = directoryName(config.directory);
        const problem = await probeDirectory(connection, directory);
        if (problem) throw new Error(`The directory ${directory} is not usable: ${problem}`);

        const [login] = await queryRows<{ LOGIN_NAME: string }>(connection, `SELECT SYS_CONTEXT('USERENV', 'SESSION_USER') AS login_name FROM dual`);
        const roles = await queryRows<{ ROLE: string }>(connection, `SELECT role FROM session_roles WHERE role IN ('DATAPUMP_IMP_FULL_DATABASE', 'IMP_FULL_DATABASE')`);
        const privileged = roles.length > 0;

        for (const requested of databases) {
            const target = await resolveTarget(connection, requested);
            if (!privileged && target.name !== login?.LOGIN_NAME) {
                throw new Error(`Restoring into ${target.name} needs the role DATAPUMP_IMP_FULL_DATABASE, which ${login?.LOGIN_NAME ?? "this login"} does not have`);
            }
        }
    });
}

/**
 * Oracle never wrote the older backup formats. restore() exists because the interface still
 * asks for it, and restores one dump the way restoreOne() does.
 */
export async function restore(
    config: OracleRestoreConfig,
    sourcePath: string,
    host: ExecutionHost,
    onLog?: OnLog,
    onProgress?: OnProgress,
): Promise<BackupResult> {
    const startedAt = new Date();
    const logs: string[] = [];
    const log: OnLog = (msg, level = "info", type = "general", details) => {
        logs.push(msg);
        onLog?.(msg, level, type, details);
    };

    try {
        const selected = config.databaseMapping?.filter((entry) => entry.selected) ?? [];
        const configured = Array.isArray(config.database) ? config.database[0] : config.database;
        const source = selected[0]?.originalName || configured;
        const target = selected[0]?.targetName || config.targetDatabaseName || source;
        if (!source || !target) {
            throw new Error("No schema given to restore into");
        }
        await restoreOne(config, sourcePath, target, host, log, onProgress, source);
        return { success: true, logs, startedAt, completedAt: new Date() };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        log(`Error: ${message}`, "error");
        return { success: false, logs, error: message, startedAt, completedAt: new Date() };
    }
}
