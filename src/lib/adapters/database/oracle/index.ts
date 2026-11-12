import { DatabaseAdapter } from "@/lib/core/interfaces";
import { OracleSchema } from "@/lib/adapters/definitions";
import { dump, dumpOne } from "./dump";
import { restore, restoreOne, prepareRestore } from "./restore";
import { test, ping, getDatabases, getDatabasesWithStats } from "./connection";
import { getTables, getTableData } from "./browser";

/**
 * Oracle Database 12.1 and later, one schema per backed up "database".
 *
 * Data Pump does the export and import inside the server, and the dump file comes and goes over
 * the SQL*Net connection, so there is no Oracle client to install. Over SSH the connection is
 * tunnelled like SQL Server's TDS, see withConnection().
 */
export const OracleAdapter: DatabaseAdapter = {
    id: "oracle",
    type: "database",
    name: "Oracle Database",
    configSchema: OracleSchema,
    credentials: { primary: "USERNAME_PASSWORD", ssh: "SSH_KEY" },
    dump,
    dumpOne,
    restore,
    restoreOne,
    prepareRestore,
    test,
    ping,
    getDatabases,
    getDatabasesWithStats,
    getTables,
    getTableData,
};
