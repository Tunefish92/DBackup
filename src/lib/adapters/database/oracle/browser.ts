import oracledb from "oracledb";

import type { ExecutionHost } from "@/lib/transport";
import type { OracleConfig } from "@/lib/adapters/definitions";
import type { ColumnInfo, TableDataOptions, TableDataResult, TableInfo } from "@/lib/core/interfaces";
import { queryRows, withConnection, type OracleConnection } from "./connection";
import { assertSchemaName, quoteIdentifier } from "./identifiers";

/**
 * The Database Explorer for Oracle: the tables and views of a schema, and a page of rows.
 *
 * Schema, table and column names are checked against the dictionary before they are quoted
 * into a statement, so a name only reaches SQL once Oracle has confirmed it exists.
 */

/** Tables a person made, without the recycle bin, IOT overflow segments and nested tables. */
const TABLES_QUERY = `
SELECT table_name AS name, num_rows AS row_count, 'table' AS kind
  FROM all_tables
 WHERE owner = :p_owner_tables AND dropped = 'NO' AND nested = 'NO' AND secondary = 'N'
   AND (iot_type IS NULL OR iot_type = 'IOT')
UNION ALL
SELECT view_name, NULL, 'view'
  FROM all_views
 WHERE owner = :p_owner_views
 ORDER BY 1`;

const COLUMNS_QUERY = `
SELECT c.column_name, c.data_type, c.nullable,
       CASE WHEN EXISTS (
           SELECT 1
             FROM all_constraints cons
             JOIN all_cons_columns cons_col ON cons_col.owner = cons.owner AND cons_col.constraint_name = cons.constraint_name
            WHERE cons.owner = c.owner AND cons.table_name = c.table_name
              AND cons.constraint_type = 'P' AND cons_col.column_name = c.column_name
       ) THEN 'Y' ELSE 'N' END AS is_primary
  FROM all_tab_columns c
 WHERE c.owner = :p_owner AND c.table_name = :p_table
 ORDER BY c.column_id`;

const LOB_TEXT = new Set(["CLOB", "NCLOB"]);
const NOT_SEARCHABLE = new Set(["BLOB", "BFILE", "RAW", "LONG", "LONG RAW"]);

export async function getTables(config: OracleConfig, database: string, host: ExecutionHost): Promise<TableInfo[]> {
    const schema = assertSchemaName(database);
    return withConnection(config, host, async (connection) => {
        const rows = await queryRows<{ NAME: string; ROW_COUNT: number | null; KIND: string }>(
            connection,
            TABLES_QUERY,
            { p_owner_tables: schema, p_owner_views: schema },
        );
        return rows.map((row) => ({
            name: row.NAME,
            type: (row.KIND.trim() === "view" ? "view" : "table") as TableInfo["type"],
            rowCount: row.ROW_COUNT === null ? undefined : Number(row.ROW_COUNT),
        }));
    });
}

interface ColumnRow {
    COLUMN_NAME: string;
    DATA_TYPE: string;
    NULLABLE: string;
    IS_PRIMARY: string;
}

/** A value the page can show: LOBs read as text or bytes, binary as hex. */
function displayValue(value: unknown): unknown {
    if (value === null || value === undefined) return null;
    if (Buffer.isBuffer(value)) {
        const hex = value.subarray(0, 128).toString("hex").toUpperCase();
        return `0x${hex}${value.length > 128 ? "..." : ""}`;
    }
    // A BFILE stays a LOB locator, which only points at a file on the server.
    if (typeof value === "object" && typeof (value as { getData?: unknown }).getData === "function") return "(BFILE)";
    return value;
}

/** CLOBs come back as strings and BLOBs as Buffers instead of LOB locators the page cannot read. */
function fetchTypeHandler(metadata: oracledb.Metadata<unknown>): oracledb.FetchTypeResponse | undefined {
    if (metadata.dbType === oracledb.DB_TYPE_CLOB || metadata.dbType === oracledb.DB_TYPE_NCLOB) return { type: oracledb.STRING };
    if (metadata.dbType === oracledb.DB_TYPE_BLOB) return { type: oracledb.BUFFER };
    return undefined;
}

async function tableColumns(connection: OracleConnection, schema: string, table: string): Promise<ColumnRow[]> {
    const columns = await queryRows<ColumnRow>(connection, COLUMNS_QUERY, { p_owner: schema, p_table: table });
    if (columns.length === 0) {
        throw new Error(`Table ${schema}.${table} does not exist, or the login cannot see it`);
    }
    return columns;
}

/** The search condition and its bind, or none when no search is asked for. */
function searchClause(column: ColumnRow | undefined, options: TableDataOptions): { sql: string; value?: string } {
    if (!options.search || !column) return { sql: "" };
    if (NOT_SEARCHABLE.has(column.DATA_TYPE)) {
        throw new Error(`Column ${column.COLUMN_NAME} holds binary data and cannot be searched`);
    }
    const quoted = quoteIdentifier(column.COLUMN_NAME);
    const text = LOB_TEXT.has(column.DATA_TYPE) ? `DBMS_LOB.SUBSTR(${quoted}, 4000, 1)` : `TO_CHAR(${quoted})`;
    const term = options.search;
    switch (options.matchMode) {
        case "equals": return { sql: ` WHERE ${text} = :p_search`, value: term };
        case "starts": return { sql: ` WHERE ${text} LIKE :p_search`, value: `${term}%` };
        case "ends": return { sql: ` WHERE ${text} LIKE :p_search`, value: `%${term}` };
        default: return { sql: ` WHERE ${text} LIKE :p_search`, value: `%${term}%` };
    }
}

export async function getTableData(config: OracleConfig, options: TableDataOptions, host: ExecutionHost): Promise<TableDataResult> {
    const schema = assertSchemaName(options.database);
    const table = assertSchemaName(options.table);
    const pageSize = Math.max(1, Math.min(Math.floor(options.pageSize) || 50, 1000));
    const offset = Math.max(0, (Math.floor(options.page) - 1) * pageSize);

    return withConnection(config, host, async (connection) => {
        const columnRows = await tableColumns(connection, schema, table);
        const byName = new Map(columnRows.map((column) => [column.COLUMN_NAME, column]));
        const source = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;

        const searchColumn = options.searchColumn ? byName.get(options.searchColumn) : undefined;
        const search = searchClause(searchColumn, options);
        const searchBinds: Record<string, string> = search.value !== undefined ? { p_search: search.value } : {};

        const sortColumn = options.sortBy ? byName.get(options.sortBy) : undefined;
        const orderBy = sortColumn && !NOT_SEARCHABLE.has(sortColumn.DATA_TYPE) && !LOB_TEXT.has(sortColumn.DATA_TYPE)
            ? ` ORDER BY ${quoteIdentifier(sortColumn.COLUMN_NAME)} ${options.sortDir === "desc" ? "DESC" : "ASC"}`
            : "";

        const count = await connection.execute<[number]>(
            `SELECT COUNT(*) FROM ${source}${search.sql}`,
            searchBinds,
            { outFormat: oracledb.OUT_FORMAT_ARRAY },
        );
        const data = await connection.execute<Record<string, unknown>>(
            `SELECT * FROM ${source}${search.sql}${orderBy} OFFSET :p_offset ROWS FETCH NEXT :p_limit ROWS ONLY`,
            { ...searchBinds, p_offset: offset, p_limit: pageSize },
            { outFormat: oracledb.OUT_FORMAT_OBJECT, fetchTypeHandler },
        );

        const columns: ColumnInfo[] = columnRows.map((column) => ({
            name: column.COLUMN_NAME,
            dataType: column.DATA_TYPE,
            nullable: column.NULLABLE === "Y",
            primaryKey: column.IS_PRIMARY === "Y",
        }));

        const rows = (data.rows ?? []).map((row) => {
            const record: Record<string, unknown> = {};
            for (const column of columns) record[column.name] = displayValue(row[column.name]);
            return record;
        });

        return { rows, totalCount: Number(count.rows?.[0]?.[0] ?? 0), columns };
    });
}
