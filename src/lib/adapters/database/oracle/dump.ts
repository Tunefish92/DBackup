import fs from "fs/promises";

import type { ExecutionHost } from "@/lib/transport";
import type { BackupResult } from "@/lib/core/interfaces";
import type { LogLevel, LogType } from "@/lib/core/logs";
import type { OracleConfig } from "@/lib/adapters/definitions";
import { formatBytes } from "@/lib/utils";
import { queryRows, withConnection, type OracleConnection } from "./connection";
import { excerpt, logDetails, reviewLog, runExport, type JobFiles } from "./datapump";
import { downloadFile, readTextTail, removeRemoteFile } from "./files";
import { assertSchemaName, directoryName, runNames } from "./identifiers";

type OnLog = (msg: string, level?: LogLevel, type?: LogType, details?: string) => void;

/**
 * Backing up one schema: a Data Pump export into the directory object, then the dump file
 * copied over the connection into the local file, then both files removed from the server.
 *
 * The dump never needs room in DBackup and on the server at once for longer than the copy,
 * but the directory must hold one whole dump of the largest schema.
 */

/** The schema exists and is one a backup can hold, before Data Pump starts a job for it. */
async function checkSchema(connection: OracleConnection, schema: string): Promise<void> {
    const rows = await queryRows<{ ORACLE_MAINTAINED: string }>(
        connection,
        `SELECT oracle_maintained FROM all_users WHERE username = :p_schema`,
        { p_schema: schema },
    );
    if (rows.length === 0) {
        throw new Error(`Schema ${schema} does not exist, or the login cannot see it`);
    }
    if (rows[0].ORACLE_MAINTAINED === "Y") {
        throw new Error(`Schema ${schema} belongs to Oracle itself and is not backed up with Data Pump`);
    }
}

/**
 * Exports `schema` into `destinationPath`. Throws when the export fails or reports lost data,
 * and leaves no file behind on the server either way.
 */
export async function exportSchema(
    connection: OracleConnection,
    config: OracleConfig,
    schema: string,
    destinationPath: string,
    onLog: OnLog,
): Promise<number> {
    assertSchemaName(schema);
    await checkSchema(connection, schema);

    const directory = directoryName(config.directory);
    const names = runNames("EXP");
    const files: JobFiles = { job: names.job, directory, dumpFile: names.dumpFile, logFile: names.logFile };
    const consistent = config.consistent !== false;

    onLog(
        `Exporting schema ${schema} with Data Pump`,
        "info",
        "command",
        `DBMS_DATAPUMP export, job ${files.job}, schema ${schema}, directory ${directory}, consistent=${consistent ? "yes" : "no"}`,
    );

    try {
        const state = await runExport(connection, files, schema, consistent);
        const log = await readTextTail(connection, directory, files.logFile).catch(() => "");
        const review = reviewLog(log);

        if (state !== "COMPLETED") {
            throw new Error(`Data Pump export of ${schema} ended as ${state}${review.errors.length ? `:\n${excerpt(review.errors)}` : ""}`);
        }
        if (review.dataLoss.length > 0) {
            throw new Error(`Data Pump could not export all data of ${schema}:\n${excerpt(review.dataLoss)}`);
        }
        if (review.errors.length > 0) {
            onLog(`Data Pump reported ${review.errors.length} warning(s) for ${schema}`, "warning", "general", excerpt(review.errors, 50));
        }
        onLog(review.summary ?? `Data Pump export of ${schema} completed`, "info", "command", logDetails(log));

        const started = Date.now();
        const size = await downloadFile(connection, directory, files.dumpFile, destinationPath);
        const seconds = Math.max((Date.now() - started) / 1000, 0.001);
        onLog(`Copied the dump of ${schema} from the server: ${formatBytes(size)} at ${formatBytes(size / seconds)}/s`);
        return size;
    } finally {
        await removeRemoteFile(connection, directory, files.dumpFile);
        await removeRemoteFile(connection, directory, files.logFile);
    }
}

/**
 * Dumps exactly one schema into a plain local file, an entry of the seekable archive.
 */
export async function dumpOne(
    config: OracleConfig,
    dbName: string,
    destinationPath: string,
    host: ExecutionHost,
    onLog?: OnLog,
): Promise<{ size: number }> {
    const log: OnLog = onLog ?? (() => {});
    const size = await withConnection(config, host, (connection) => exportSchema(connection, config, dbName, destinationPath, log));
    const stats = await fs.stat(destinationPath);
    if (stats.size === 0 || stats.size !== size) {
        throw new Error(`The dump of ${dbName} is ${stats.size} bytes, the server reported ${size}`);
    }
    return { size: stats.size };
}

/**
 * Oracle never wrote the older backup formats. dump() exists because the interface still asks
 * for it, and writes the one selected schema the way dumpOne() does.
 */
export async function dump(
    config: OracleConfig,
    destinationPath: string,
    host: ExecutionHost,
    onLog?: OnLog,
): Promise<BackupResult> {
    const startedAt = new Date();
    const logs: string[] = [];
    const log: OnLog = (msg, level = "info", type = "general", details) => {
        logs.push(msg);
        onLog?.(msg, level, type, details);
    };

    try {
        const selected = Array.isArray(config.database)
            ? config.database
            : (config.database || "").split(",").map((name) => name.trim()).filter(Boolean);
        if (selected.length !== 1) {
            throw new Error("Select exactly one schema. A backup of several schemas is written by dumpOne() into an archive.");
        }
        const { size } = await dumpOne(config, selected[0], destinationPath, host, log);
        return { success: true, path: destinationPath, size, logs, startedAt, completedAt: new Date() };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        log(`Error: ${message}`, "error");
        return { success: false, logs, error: message, startedAt, completedAt: new Date() };
    }
}
