import { queryRows, type OracleConnection } from "./connection";

/**
 * Recompiling a schema after an import.
 *
 * An import that replaces tables leaves the views, procedures and triggers that depend on them
 * INVALID when they already existed and were kept. Oracle compiles such an object again the next
 * time it is used, but until then every tool lists it as broken. DBMS_UTILITY.COMPILE_SCHEMA with
 * `compile_all => FALSE` compiles only the invalid ones. Compiling runs no code of the schema.
 */

const COMPILE_BLOCK = `BEGIN DBMS_UTILITY.COMPILE_SCHEMA(schema => :p_schema, compile_all => FALSE); END;`;

const INVALID_QUERY = `SELECT object_type, object_name FROM all_objects WHERE owner = :p_schema AND status = 'INVALID' ORDER BY object_type, object_name`;

/** How many invalid objects a warning names before it only counts the rest. */
const LISTED = 20;

export interface RecompileResult {
    /** Objects still invalid afterwards, as `TYPE NAME`. */
    invalid: string[];
    /** Oracle's message when the compile itself could not run, like a login without ALTER ANY PROCEDURE. */
    failure?: string;
}

/**
 * Compiles the invalid objects of `schema` and returns what is still invalid. Never throws for a
 * compile that fails, since the data of the restore is in place either way.
 */
export async function recompileSchema(connection: OracleConnection, schema: string): Promise<RecompileResult> {
    let failure: string | undefined;
    try {
        await connection.execute(COMPILE_BLOCK, { p_schema: schema });
    } catch (error: unknown) {
        failure = error instanceof Error ? error.message : String(error);
    }
    const rows = await queryRows<{ OBJECT_TYPE: string; OBJECT_NAME: string }>(connection, INVALID_QUERY, { p_schema: schema }).catch(() => []);
    return { invalid: rows.map((row) => `${row.OBJECT_TYPE} ${row.OBJECT_NAME}`), failure };
}

/** The objects of a warning, the first `LISTED` by name and the rest as a count. */
export function listInvalid(invalid: string[]): string {
    const shown = invalid.slice(0, LISTED).join("\n");
    const more = invalid.length - LISTED;
    return more > 0 ? `${shown}\n...and ${more} more` : shown;
}
