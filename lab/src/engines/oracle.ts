/**
 * Oracle 21 XE and 23ai Free. Every container opens a pluggable database LABPDB, where the
 * dataset makes the schemas SHOP and INVENTORY and a directory object for Data Pump. A restore
 * makes a new schema next to them.
 */

import type { Clients, EngineSpec, Run } from "./types";

const login = { username: "system", password: "LabPassword1" };

/** The pluggable database every version opens, see ORACLE_DATABASE in lab/compose/databases.yml. */
export const ORACLE_SERVICE = "LABPDB";

/** The directory object of the dataset and the folder it points at in the container. */
export const ORACLE_DIRECTORY = { name: "DBACKUP_DIR", path: "/opt/oracle/oradata/dbackup" };

/** sqlplus reads its script from standard input. UTF-8 on the client keeps the names of the dataset intact. */
const clients: Clients = {
    cli: `NLS_LANG=AMERICAN_AMERICA.AL32UTF8 sqlplus -s -L ${login.username}/${login.password}@//localhost:1521/${ORACLE_SERVICE}`,
};

/** Output fit for comparing: no headings, no paging, LOBs in full, `|` between columns. */
const SETTINGS = `WHENEVER SQLERROR EXIT FAILURE
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF VERIFY OFF ECHO OFF TAB OFF
SET LINESIZE 32767 TRIMSPOOL ON TRIMOUT ON LONG 1000000 LONGCHUNKSIZE 1000000
SET COLSEP '|' NULL '<null>'
`;

const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** A column as the fingerprint reads it. SQL*Plus cannot print a BLOB, so its bytes come as hex. */
function columnExpression(column: string, type: string): string {
    return type === "BLOB" ? `RAWTOHEX(DBMS_LOB.SUBSTR("${column}", 2000, 1))` : `"${column}"`;
}

/**
 * The objects of a schema, the code of its views and procedures, then every row of every table.
 * Names Oracle makes up itself, like SYS_C0012345 for a constraint, differ in a copy and are left out.
 */
async function fingerprint(run: Run, schema: string, tools: Clients): Promise<string> {
    const owner = literal(schema);
    const metadata = await run(tools.cli, `${SETTINGS}
SELECT 'O|' || object_type || '|' || object_name FROM all_objects
 WHERE owner = ${owner} AND object_name NOT LIKE 'SYS\\_%' ESCAPE '\\' ORDER BY object_type, object_name;
SELECT 'C|' || c.table_name || '|' || c.column_name || '|' || c.data_type FROM all_tab_columns c
  JOIN all_tables tbl ON tbl.owner = c.owner AND tbl.table_name = c.table_name
 WHERE c.owner = ${owner} ORDER BY c.table_name, c.column_id;
SELECT 'S|' || name || '|' || type || '|' || line || '|' || text FROM all_source WHERE owner = ${owner} ORDER BY name, type, line;
SELECT 'V|' || view_name, text FROM all_views WHERE owner = ${owner} ORDER BY view_name;
EXIT
`);
    const columns = new Map<string, string[]>();
    for (const line of metadata.split("\n")) {
        const [kind, table, column, type] = line.trim().split("|");
        if (kind !== "C" || !table || !column) continue;
        columns.set(table, [...(columns.get(table) ?? []), columnExpression(column, type)]);
    }
    const queries = [...columns.entries()].map(([table, list]) =>
        `SELECT ${literal(`R|${table}`)}, ${list.join(", ")} FROM "${schema}"."${table}" ORDER BY 2;`);
    const rows = await run(tools.cli, `${SETTINGS}\n${queries.join("\n")}\nEXIT\n`);
    return `${metadata}\n${rows}`;
}

export const ORACLE: EngineSpec = {
    id: "oracle",
    name: "Oracle",
    versions: [
        { version: "21", service: "oracle-21", port: 15521, profile: "full" },
        { version: "23", service: "oracle-23", port: 15523, profile: "full" },
    ],
    innerPort: 1521,
    login,
    clients,
    dataset: {
        file: "oracle.sql",
        check: `echo "SELECT 'yes' FROM all_views WHERE owner = 'SHOP' AND view_name = 'ORDER_TOTALS';" | ${clients.cli} | grep -w yes || true`,
        load: `mkdir -p ${ORACLE_DIRECTORY.path} && ${clients.cli}`,
    },
    source: (target) => ({
        host: target.host,
        port: target.port,
        serviceName: ORACLE_SERVICE,
        connectionMode: "direct",
        directory: ORACLE_DIRECTORY.name,
    }),
    restores: true,
    // A schema typed in upper case, which is how Oracle stores an unquoted name.
    database: {
        name: "SHOP",
        location: "SHOP",
        restoreAs: (suffix) => {
            const name = `SHOP_${suffix.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`;
            return { name, location: name };
        },
    },
    fingerprint,
    drop: async (run: Run, schema: string, tools: Clients) => {
        await run(tools.cli, `WHENEVER SQLERROR EXIT FAILURE
BEGIN
    FOR existing IN (SELECT username FROM all_users WHERE username = ${literal(schema)}) LOOP
        EXECUTE IMMEDIATE 'DROP USER "' || existing.username || '" CASCADE';
    END LOOP;
END;
/
EXIT
`);
    },
};
