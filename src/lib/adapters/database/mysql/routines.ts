import { Transform, type TransformCallback } from "stream";
import type { ExecResult } from "@/lib/transport";
import { compareVersions } from "@/lib/utils";

/**
 * Stored procedures and functions of a MySQL server whose version the MariaDB dump tool takes for
 * MariaDB. `mariadb-dump --routines` asks every server from version 10.3 on for packages too,
 * which only MariaDB knows, so on MySQL 26 and later the dump fails with a syntax error. DBackup
 * then leaves `--routines` out and writes the routines into the dump itself, in the shape
 * mysqldump gives them, read with `SHOW CREATE` through the mysql client.
 */

/** The first version the MariaDB dump tool asks for packages. */
const PACKAGES_FROM = "10.3";

/** Whether the dump tool would ask this server for packages: a MySQL server of version 10.3 or later. */
export function needsOwnRoutines(config: { type?: string; detectedVersion?: string }): boolean {
    const version = config.detectedVersion;
    if (!version || config.type === "mariadb" || /mariadb/i.test(version)) {
        return false;
    }
    return compareVersions(version, PACKAGES_FROM) >= 0;
}

/** A row of a result the mysql client printed with `--xml`, by the name of each field, null for SQL NULL. */
export type XmlRow = Record<string, string | null>;

/** Undoes the escaping of the mysql client, which writes `<`, `>`, `&` and `"` as entities. */
function unescapeXml(text: string): string {
    return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
}

/** The rows of every result in the output of `mysql --xml`, in the order the client printed them. */
export function parseXmlRows(xml: string): XmlRow[] {
    const rows: XmlRow[] = [];
    for (const row of xml.matchAll(/<row>([\s\S]*?)<\/row>/g)) {
        const fields: XmlRow = {};
        for (const field of row[1].matchAll(/<field name="([^"]*)"(\s+xsi:nil="true")?\s*(?:\/>|>([\s\S]*?)<\/field>)/g)) {
            fields[unescapeXml(field[1])] = field[2] ? null : unescapeXml(field[3] ?? "");
        }
        rows.push(fields);
    }
    return rows;
}

/** A name between backticks, with a backtick inside doubled. */
function quoteName(name: string): string {
    return `\`${name.replace(/`/g, "``")}\``;
}

/** A routine as `SHOW CREATE` gives it, with the settings it was created under. */
export interface RoutineDefinition {
    type: "FUNCTION" | "PROCEDURE";
    name: string;
    sqlMode: string;
    create: string;
    characterSetClient: string;
    collationConnection: string;
}

/** The routines of the current database in the order mysqldump writes them, functions first, each by name. */
const ROUTINE_LIST =
    "SELECT ROUTINE_TYPE, ROUTINE_NAME FROM information_schema.ROUTINES " +
    "WHERE ROUTINE_SCHEMA = DATABASE() AND ROUTINE_TYPE IN ('FUNCTION', 'PROCEDURE') ORDER BY ROUTINE_TYPE, ROUTINE_NAME";

/** Runs SQL in the database of the dump through the mysql client with `--xml`. */
export type XmlAsk = (sql: string) => Promise<ExecResult>;

/** Throws the error of the mysql client for a question about the routines of a database. */
function assertAnswered(result: ExecResult, dbName: string): void {
    if (result.code !== 0) {
        const reason = result.stderr.trim() || `exit code ${result.code}`;
        throw new Error(`Reading the stored procedures and functions of ${dbName} failed: ${reason}`);
    }
}

/** Reads every stored procedure and function of the database with the statement that creates it. */
export async function readRoutines(ask: XmlAsk, dbName: string): Promise<RoutineDefinition[]> {
    const listed = await ask(ROUTINE_LIST);
    assertAnswered(listed, dbName);
    const routines = parseXmlRows(listed.stdout).map((row) => ({
        type: row.ROUTINE_TYPE === "FUNCTION" ? "FUNCTION" as const : "PROCEDURE" as const,
        name: row.ROUTINE_NAME ?? "",
    }));
    if (routines.length === 0) {
        return [];
    }

    // One call for all of them, each SHOW CREATE answers with a result of its own in the same order.
    const shown = await ask(routines.map((routine) => `SHOW CREATE ${routine.type} ${quoteName(routine.name)}`).join("; "));
    assertAnswered(shown, dbName);
    const rows = parseXmlRows(shown.stdout);
    if (rows.length !== routines.length) {
        throw new Error(`Reading the stored procedures and functions of ${dbName} failed: ${routines.length} listed, ${rows.length} read.`);
    }

    const definitions: RoutineDefinition[] = [];
    for (const [index, routine] of routines.entries()) {
        const row = rows[index];
        const create = row[routine.type === "FUNCTION" ? "Create Function" : "Create Procedure"];
        // NULL is a routine whose body the login may not read, which the check before the dump already left out.
        if (create === null || create === undefined) {
            throw new Error(`Reading the ${routine.type.toLowerCase()} ${routine.name} of ${dbName} failed: the login may not read its body.`);
        }
        definitions.push({
            ...routine,
            sqlMode: row.sql_mode ?? "",
            create,
            characterSetClient: row.character_set_client ?? "utf8mb4",
            collationConnection: row.collation_connection ?? "utf8mb4_general_ci",
        });
    }
    return definitions;
}

/** The SQL of the routines in the shape mysqldump writes it, empty for none. */
export function routinesSql(dbName: string, routines: RoutineDefinition[]): string {
    if (routines.length === 0) {
        return "";
    }
    const lines = [
        "",
        "--",
        `-- Dumping routines for database '${dbName.replace(/'/g, "''")}'`,
        "--",
    ];
    for (const routine of routines) {
        lines.push(
            `/*!50003 DROP ${routine.type} IF EXISTS ${quoteName(routine.name)} */;`,
            "/*!50003 SET @saved_cs_client      = @@character_set_client */ ;",
            "/*!50003 SET @saved_cs_results     = @@character_set_results */ ;",
            "/*!50003 SET @saved_col_connection = @@collation_connection */ ;",
            `/*!50003 SET character_set_client  = ${routine.characterSetClient} */ ;`,
            `/*!50003 SET character_set_results = ${routine.characterSetClient} */ ;`,
            `/*!50003 SET collation_connection  = ${routine.collationConnection} */ ;`,
            "/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;",
            `/*!50003 SET sql_mode              = '${routine.sqlMode.replace(/'/g, "''")}' */ ;`,
            "DELIMITER ;;",
            routine.create,
            ";;",
            "DELIMITER ;",
            "/*!50003 SET sql_mode              = @saved_sql_mode */ ;",
            "/*!50003 SET character_set_client  = @saved_cs_client */ ;",
            "/*!50003 SET character_set_results = @saved_cs_results */ ;",
            "/*!50003 SET collation_connection  = @saved_col_connection */ ;",
        );
    }
    lines.push("");
    return `${lines.join("\n")}\n`;
}

/** How far into a dump the `USE` of its database is looked for, it comes within its first lines. */
const USE_SEARCH_LIMIT = 1024 * 1024;

/**
 * Passes a dump through and writes `sql` right after the `USE` of its database, so the routines
 * exist before the views at the end of the dump, which MySQL refuses to create without the
 * functions they call. A dump without that line gets them at its end.
 */
export function insertAfterUse(sql: string): Transform {
    const insert = Buffer.from(sql, "utf8");
    let head = Buffer.alloc(0);
    // Searching for the USE, inserted after it, or given up on it, which writes the routines at the end.
    let state: "searching" | "inserted" | "atEnd" = insert.length === 0 ? "inserted" : "searching";
    return new Transform({
        transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
            if (state !== "searching") {
                callback(null, chunk);
                return;
            }
            head = Buffer.concat([head, chunk]);
            const use = head.indexOf("USE `") === 0 ? 0 : head.indexOf("\nUSE `");
            const end = use >= 0 ? head.indexOf("\n", use + 1) : -1;
            if (end >= 0) {
                state = "inserted";
                const passed = Buffer.concat([head.subarray(0, end + 1), insert, head.subarray(end + 1)]);
                head = Buffer.alloc(0);
                callback(null, passed);
                return;
            }
            if (head.length > USE_SEARCH_LIMIT) {
                state = "atEnd";
                const passed = head;
                head = Buffer.alloc(0);
                callback(null, passed);
                return;
            }
            callback();
        },
        flush(callback: TransformCallback) {
            callback(null, state === "inserted" ? head : Buffer.concat([head, insert]));
        },
    });
}
