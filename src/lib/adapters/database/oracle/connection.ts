import oracledb from "oracledb";

import { transportSuffix, type ExecutionHost } from "@/lib/transport";
import type { OracleConfig } from "@/lib/adapters/definitions";
import type { DatabaseInfo } from "@/lib/core/interfaces";
import { connectString, directoryName } from "./identifiers";
import { probeDirectory } from "./files";

/**
 * Opening a SQL*Net connection, through an SSH tunnel when the transport asks for one.
 *
 * Every connection of this adapter goes through withConnection(). node-oracledb runs in its Thin
 * mode, pure JavaScript without Oracle client libraries, so a tunnel is nothing more than the
 * port the driver dials.
 */

const NO_HOST_MESSAGE = "Oracle adapter requires an execution host. Call it through withHost().";

/** Seconds to wait for the listener, so a dead server fails a test instead of hanging it. */
const CONNECT_TIMEOUT_S = 15;

/**
 * Minutes between TCP keepalive probes. A Data Pump job holds one call open for its whole
 * length without sending anything, which a firewall or NAT in between may take for a dead
 * connection and drop.
 */
const KEEPALIVE_MINUTES = 1;

/** Every schema Oracle installs itself is marked ORACLE_MAINTAINED, from 12.1 on. */
const USER_SCHEMAS_QUERY = `SELECT username FROM all_users WHERE oracle_maintained = 'N' ORDER BY username`;

export type OracleConnection = oracledb.Connection;

/** Rows of a query as plain objects keyed by column name, the way Oracle names them, upper case. */
export async function queryRows<T = Record<string, unknown>>(
    connection: OracleConnection,
    sql: string,
    binds: oracledb.BindParameters = {},
): Promise<T[]> {
    const result = await connection.execute<T>(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return result.rows ?? [];
}

/**
 * Run `fn` against an open connection, closing it and any tunnel afterwards.
 */
export async function withConnection<T>(
    config: OracleConfig,
    host: ExecutionHost,
    fn: (connection: OracleConnection) => Promise<T>,
): Promise<T> {
    if (!host) throw new Error(NO_HOST_MESSAGE);

    const forward = await host.forwardPort(config.host, config.port || 1521);
    let connection: OracleConnection | null = null;
    try {
        if (config.tls && forward.forwarded) {
            // The driver checks the certificate against the host it dials, which through a
            // tunnel is 127.0.0.1. Turning that check off would make TLS look on while it
            // verified nothing, so the combination is refused instead.
            throw new Error("TLS cannot be checked through an SSH tunnel. Turn TLS off, the SSH connection already encrypts the way to the server.");
        }
        try {
            connection = await oracledb.getConnection({
                user: config.user,
                password: config.password ?? "",
                connectString: connectString(forward.host, forward.port, config.serviceName, !!config.tls),
                connectTimeout: CONNECT_TIMEOUT_S,
                expireTime: KEEPALIVE_MINUTES,
            });
        } catch (error: unknown) {
            // A forwarding refusal surfaces at the driver as a reset connection, so the real
            // cause is attached here where it is still known.
            if (forward.lastError) {
                const detail = error instanceof Error ? error.message : String(error);
                throw new Error(`${detail} (SSH tunnel: ${forward.lastError.message})`);
            }
            throw error;
        }
        return await fn(connection);
    } finally {
        if (connection) await connection.close().catch(() => {});
        await forward.close().catch(() => {});
    }
}

/** The version as DBackup compares versions, like 23.6.0.24.10, from the string the server sends. */
export function serverVersion(connection: OracleConnection): string | undefined {
    const raw = connection.oracleServerVersionString;
    const match = typeof raw === "string" ? raw.match(/\d+(?:\.\d+)+/) : null;
    return match ? match[0] : undefined;
}

/** The schemas a job can back up: every user that Oracle did not create itself. */
export async function listSchemas(connection: OracleConnection): Promise<string[]> {
    const rows = await queryRows<{ USERNAME: string }>(connection, USER_SCHEMAS_QUERY);
    return rows.map((row) => row.USERNAME);
}

export async function getDatabases(config: OracleConfig, host: ExecutionHost): Promise<string[]> {
    return withConnection(config, host, listSchemas);
}

/**
 * Sizes come from DBA_SEGMENTS, which a backup login with DATAPUMP_EXP_FULL_DATABASE can read.
 * A login that cannot falls back to the tables it sees in ALL_TABLES, without sizes.
 */
async function schemaStats(connection: OracleConnection): Promise<Map<string, { size?: number; tables?: number }>> {
    const stats = new Map<string, { size?: number; tables?: number }>();
    try {
        const sizes = await queryRows<{ OWNER: string; BYTES: number }>(
            connection,
            `SELECT owner, SUM(bytes) AS bytes FROM dba_segments GROUP BY owner`,
        );
        const tables = await queryRows<{ OWNER: string; TABLES: number }>(
            connection,
            `SELECT owner, COUNT(*) AS tables FROM dba_tables GROUP BY owner`,
        );
        for (const row of sizes) stats.set(row.OWNER, { size: Number(row.BYTES) });
        for (const row of tables) stats.set(row.OWNER, { ...stats.get(row.OWNER), tables: Number(row.TABLES) });
        return stats;
    } catch {
        const tables = await queryRows<{ OWNER: string; TABLES: number }>(
            connection,
            `SELECT owner, COUNT(*) AS tables FROM all_tables GROUP BY owner`,
        );
        for (const row of tables) stats.set(row.OWNER, { tables: Number(row.TABLES) });
        return stats;
    }
}

export async function getDatabasesWithStats(config: OracleConfig, host: ExecutionHost): Promise<DatabaseInfo[]> {
    return withConnection(config, host, async (connection) => {
        const schemas = await listSchemas(connection);
        const stats = await schemaStats(connection).catch(() => new Map<string, { size?: number; tables?: number }>());
        return schemas.map((name) => {
            const entry = stats.get(name);
            return { name, sizeInBytes: entry?.size ?? 0, tableCount: entry?.tables ?? 0 };
        });
    });
}

/**
 * Connects, then writes, measures and removes a small file in the directory object. The file
 * travels the same way a dump does, so a directory whose path is missing on the server or that
 * the login may not write fails here rather than in the middle of the first backup.
 */
export async function test(
    config: OracleConfig,
    host?: ExecutionHost,
): Promise<{ success: boolean; message: string; version?: string }> {
    if (!host) return { success: false, message: NO_HOST_MESSAGE };
    const via = transportSuffix(host);

    try {
        return await withConnection(config, host, async (connection) => {
            const version = serverVersion(connection);
            const directory = directoryName(config.directory);
            const problem = await probeDirectory(connection, directory);
            if (problem) {
                return { success: false, message: `Connected, but the directory ${directory} is not usable: ${problem}`, version };
            }
            return { success: true, message: `Connection successful${via}`, version };
        });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, message: `Connection failed: ${message}` };
    }
}

/**
 * Lightweight check for the periodic health check: opens the listener port as reachable from
 * the execution host, without logging in.
 */
export async function ping(
    config: OracleConfig,
    host?: ExecutionHost,
): Promise<{ success: boolean; message: string }> {
    if (!host) return { success: false, message: NO_HOST_MESSAGE };
    const via = transportSuffix(host);
    try {
        const socket = await host.connect(config.host, config.port || 1521);
        socket.destroy();
        return { success: true, message: `Connection successful${via}` };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, message: `Connection failed: ${message}` };
    }
}
