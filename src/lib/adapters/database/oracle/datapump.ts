import oracledb from "oracledb";

import type { OracleConnection } from "./connection";
import { quoteLiteral } from "./identifiers";

/**
 * Data Pump jobs, run through DBMS_DATAPUMP inside the server.
 *
 * The same API expdp and impdp use, without their client binaries. A job writes its dump and
 * its log into a directory object, and WAIT_FOR_JOB holds the call until the job is done, so
 * one execute() covers a whole export or import.
 *
 * When a job fails to start, Oracle's own message is usually just ORA-39001 or ORA-39002. The
 * reason sits in the job's error status, so the exception handler collects it from there, the
 * way the example in Oracle's Utilities guide does, and stops the job so no master table stays
 * behind.
 */

const ERROR_HANDLER = `
EXCEPTION
    WHEN OTHERS THEN
        l_message := SQLERRM;
        IF l_handle IS NOT NULL THEN
            BEGIN
                DBMS_DATAPUMP.GET_STATUS(l_handle, DBMS_DATAPUMP.KU$_STATUS_JOB_ERROR, 0, l_state, l_status);
                l_errors := l_status.error;
                IF l_errors IS NOT NULL THEN
                    l_index := l_errors.FIRST;
                    WHILE l_index IS NOT NULL LOOP
                        l_message := SUBSTR(l_message || CHR(10) || l_errors(l_index).LogText, 1, 4000);
                        l_index := l_errors.NEXT(l_index);
                    END LOOP;
                END IF;
            EXCEPTION
                WHEN OTHERS THEN
                    NULL;
            END;
            BEGIN
                DBMS_DATAPUMP.STOP_JOB(handle => l_handle, immediate => 1, keep_master => 0);
            EXCEPTION
                WHEN OTHERS THEN
                    BEGIN
                        DBMS_DATAPUMP.DETACH(handle => l_handle);
                    EXCEPTION
                        WHEN OTHERS THEN
                            NULL;
                    END;
            END;
        END IF;
        RAISE_APPLICATION_ERROR(-20001, SUBSTR(l_message, 1, 2000));
END;`;

const DECLARATIONS = `
DECLARE
    l_handle  NUMBER;
    l_state   VARCHAR2(30);
    l_status  ku$_Status;
    l_errors  ku$_LogEntry;
    l_index   NUMBER;
    l_message VARCHAR2(4000);`;

const ADD_FILES = `
    DBMS_DATAPUMP.ADD_FILE(handle => l_handle, filename => :p_dump_file, directory => :p_dir, filetype => DBMS_DATAPUMP.KU$_FILE_TYPE_DUMP_FILE);
    DBMS_DATAPUMP.ADD_FILE(handle => l_handle, filename => :p_log_file, directory => :p_dir_log, filetype => DBMS_DATAPUMP.KU$_FILE_TYPE_LOG_FILE);
    DBMS_DATAPUMP.METADATA_FILTER(handle => l_handle, name => 'SCHEMA_EXPR', value => :p_schema_expr);`;

const RUN_JOB = `
    DBMS_DATAPUMP.START_JOB(handle => l_handle);
    DBMS_DATAPUMP.WAIT_FOR_JOB(handle => l_handle, job_state => l_state);
    :p_state := l_state;`;

/**
 * Exports one schema. With consistency on, FLASHBACK_TIME pins every table to the moment the
 * job starts, which is what expdp's legacy CONSISTENT=Y did.
 */
export const EXPORT_BLOCK = `${DECLARATIONS}
BEGIN
    l_handle := DBMS_DATAPUMP.OPEN(operation => 'EXPORT', job_mode => 'SCHEMA', job_name => :p_job);
${ADD_FILES}
    IF :p_consistent = 1 THEN
        DBMS_DATAPUMP.SET_PARAMETER(handle => l_handle, name => 'FLASHBACK_TIME', value => 'SYSTIMESTAMP');
    END IF;
${RUN_JOB}
${ERROR_HANDLER}`;

/**
 * Imports one schema, under another name when source and target differ. Tables that exist are
 * replaced by the ones of the dump. Other objects that exist stay and are reported, which is
 * Oracle's ORA-31684.
 */
export const IMPORT_BLOCK = `${DECLARATIONS}
    l_source VARCHAR2(128) := :p_source;
    l_target VARCHAR2(128) := :p_target;
BEGIN
    l_handle := DBMS_DATAPUMP.OPEN(operation => 'IMPORT', job_mode => 'SCHEMA', job_name => :p_job);
${ADD_FILES}
    IF l_source <> l_target THEN
        DBMS_DATAPUMP.METADATA_REMAP(handle => l_handle, name => 'REMAP_SCHEMA', old_value => l_source, value => l_target);
    END IF;
    DBMS_DATAPUMP.SET_PARAMETER(handle => l_handle, name => 'TABLE_EXISTS_ACTION', value => 'REPLACE');
${RUN_JOB}
${ERROR_HANDLER}`;

/** The filter that keeps a job to one schema, as Data Pump wants it: an IN list of literals. */
export function schemaExpression(schema: string): string {
    return `IN (${quoteLiteral(schema)})`;
}

export interface JobFiles {
    job: string;
    directory: string;
    dumpFile: string;
    logFile: string;
}

/** Runs a prepared export or import block and returns the state Data Pump ended in. */
async function runJob(connection: OracleConnection, block: string, files: JobFiles, schema: string, extra: Record<string, unknown>): Promise<string> {
    const result = await connection.execute<{ p_state: string }>(block, {
        p_job: files.job,
        p_dump_file: files.dumpFile,
        p_log_file: files.logFile,
        p_dir: files.directory,
        p_dir_log: files.directory,
        p_schema_expr: schemaExpression(schema),
        p_state: { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 30 },
        ...extra,
    } as oracledb.BindParameters);
    return result.outBinds?.p_state ?? "UNKNOWN";
}

export function runExport(connection: OracleConnection, files: JobFiles, schema: string, consistent: boolean): Promise<string> {
    return runJob(connection, EXPORT_BLOCK, files, schema, { p_consistent: consistent ? 1 : 0 });
}

export function runImport(connection: OracleConnection, files: JobFiles, source: string, target: string): Promise<string> {
    return runJob(connection, IMPORT_BLOCK, files, source, { p_source: source, p_target: target });
}

/**
 * Errors after which a schema is missing data: a table whose rows could not be unloaded or
 * loaded, a table that could not be created, a worker that died, or rows that did not convert.
 */
const DATA_LOSS = [/^ORA-31693\b/, /^ORA-39126\b/, /^ORA-02374\b/, /^ORA-39083\b.*\bTABLE:/];

/**
 * Lines an import writes for an object it kept because the schema already holds it: ORA-31684
 * for the object itself, ORA-39111 for a step that belongs to such an object, like the
 * ALTER_PROCEDURE of a kept procedure. Data Pump counts them as errors, but a restore into an
 * existing schema writes them for every object other than a table, so they are expected.
 */
const KEPT = [/^ORA-31684\b/, /^ORA-39111\b/];

export interface LogReview {
    /** The closing line of the job, like "Job ... successfully completed at ...". */
    summary?: string;
    /** Every ORA- line of the log. */
    errors: string[];
    /** The ORA- lines that mean rows or tables are missing. */
    dataLoss: string[];
    /** The ORA- lines of objects kept because they already exist, see `KEPT`. */
    kept: string[];
    /** Every other ORA- line, the ones worth a warning. */
    warnings: string[];
}

/** What a Data Pump log says about its job. */
export function reviewLog(text: string): LogReview {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
    const errors = lines.filter((line) => /^ORA-\d+/.test(line));
    const dataLoss = errors.filter((line) => DATA_LOSS.some((pattern) => pattern.test(line)));
    const kept = errors.filter((line) => KEPT.some((pattern) => pattern.test(line)));
    const warnings = errors.filter((line) => !kept.includes(line));
    const summary = [...lines].reverse().find((line) => /^Job\s.+\b(successfully completed|completed with \d+ error|stopped)/i.test(line));
    return { summary, errors, dataLoss, kept, warnings };
}

/** The name of the object of a kept line, like `SEQUENCE "SHOP"."INVOICE_NUMBER"`, or the line itself. */
export function keptObject(line: string): string {
    const match = /Object type ([A-Z_ ]+):(\S+) already exists/.exec(line) ?? /base object type ([A-Z_ ]+):(\S+) already exists/.exec(line);
    return match ? `${match[1]} ${match[2]}` : line;
}

/** The log as details of a log entry. A schema of thousands of tables writes a long one, so only its end is kept. */
export function logDetails(text: string, maxChars = 64 * 1024): string | undefined {
    if (!text) return undefined;
    return text.length > maxChars ? `...\n${text.slice(-maxChars)}` : text;
}

/** At most `limit` lines of a list, with how many more there are. */
export function excerpt(lines: string[], limit = 5): string {
    const shown = lines.slice(0, limit).join("\n");
    return lines.length > limit ? `${shown}\n... and ${lines.length - limit} more` : shown;
}
