import { randomBytes } from "crypto";

/**
 * Names that end up in a connect string, in PL/SQL or in a file name on the server.
 *
 * Schema names are never pasted into SQL as identifiers here. They travel as bind values, and
 * the two places that need them inside a statement, a Data Pump schema filter and a table of
 * the Database Explorer, quote them with the rules below.
 */

/** An unquoted Oracle name: a letter first, then letters, digits, `_`, `$` and `#`. */
const UNQUOTED_NAME = /^[A-Za-z][A-Za-z0-9_$#]*$/;

/** Hosts reach the Easy Connect string unquoted, so nothing that could start a descriptor gets in. */
const HOST_NAME = /^[A-Za-z0-9._-]+$/;
const IPV6_ADDRESS = /^\[?[0-9A-Fa-f:.]+\]?$/;

/**
 * The directory object as Oracle stores it. An unquoted name is upper case in the dictionary,
 * and both UTL_FILE and Data Pump take the stored name, so `data_pump_dir` would not be found.
 */
export function directoryName(directory: string | undefined): string {
    const name = (directory ?? "").trim() || "DATA_PUMP_DIR";
    if (!UNQUOTED_NAME.test(name) || name.length > 128) {
        throw new Error(`Directory object '${name}' is not a valid Oracle name. Use an unquoted name like DATA_PUMP_DIR.`);
    }
    return name.toUpperCase();
}

/**
 * Whether a name could be a schema at all. Oracle cannot quote a double quote inside a quoted
 * name, so a name holding one is refused before it reaches any statement.
 */
export function assertSchemaName(name: string): string {
    if (!name || name.length > 128 || name.includes("\"") || name.includes("\0")) {
        throw new Error(`'${name}' is not a valid Oracle schema name.`);
    }
    return name;
}

/**
 * The name a new schema gets. Typed in lower case it means what SQL*Plus would make of it, the
 * upper case name, rather than a quoted lower case user nobody can log in as without quotes.
 * A name in any other case is taken as it is.
 */
export function newSchemaName(name: string): string {
    const trimmed = assertSchemaName(name.trim());
    return /^[a-z][a-z0-9_$#]*$/.test(trimmed) ? trimmed.toUpperCase() : trimmed;
}

/** A name as a quoted identifier, for the few statements that cannot bind it. */
export function quoteIdentifier(name: string): string {
    return `"${assertSchemaName(name)}"`;
}

/** A value as a SQL string literal. */
export function quoteLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The Easy Connect string of a server. IPv6 addresses go in brackets, and TLS switches the
 * protocol to TCPS.
 */
export function connectString(host: string, port: number, serviceName: string, tls: boolean): string {
    const address = host.trim();
    let hostPart: string;
    if (HOST_NAME.test(address)) {
        hostPart = address;
    } else if (address.includes(":") && IPV6_ADDRESS.test(address)) {
        hostPart = `[${address.replace(/^\[|\]$/g, "")}]`;
    } else {
        throw new Error(`Host '${address}' is not a valid host name or address.`);
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._$#-]*$/.test(serviceName)) {
        throw new Error(`Service name '${serviceName}' contains characters Oracle does not allow.`);
    }
    return `${tls ? "tcps://" : ""}${hostPart}:${port}/${serviceName}`;
}

/** A short random tag, unique enough to keep two runs against one directory apart. */
function tag(): string {
    return randomBytes(6).toString("hex").toUpperCase();
}

/**
 * Names for one Data Pump run: the job, which Oracle lists in DBA_DATAPUMP_JOBS, and its dump
 * and log file in the directory. The job name stays within the 30 characters of Oracle 12.1.
 */
export function runNames(kind: "EXP" | "IMP"): { job: string; dumpFile: string; logFile: string } {
    const id = tag();
    return {
        job: `DBACKUP_${kind}_${id}`,
        dumpFile: `dbackup_${kind.toLowerCase()}_${id.toLowerCase()}.dmp`,
        logFile: `dbackup_${kind.toLowerCase()}_${id.toLowerCase()}.log`,
    };
}

/** The name of the small file the connection test writes and removes again. */
export function probeFileName(): string {
    return `dbackup_probe_${tag().toLowerCase()}.tmp`;
}
