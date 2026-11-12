import { createHash } from "crypto";

/**
 * An in-memory stand-in for an Oracle server, as far as the Oracle adapter talks to it.
 *
 * It answers the adapter's statements by what they do, not by their exact text: a directory
 * object that UTL_FILE writes into and a BFILE reads from, Data Pump jobs that turn a schema
 * into a dump file and a dump file back into a schema, and the dictionary views the adapter
 * reads. A dump is a JSON header with the schema and its tables followed by filler bytes, so
 * a round trip can check both the bytes and what arrived in the target schema.
 */

export interface FakeOracleOptions {
    /** Schemas of the server with their tables and rows. */
    schemas?: Record<string, Record<string, number>>;
    /** Schemas Oracle installed itself. */
    maintained?: string[];
    /** Bytes of filler in every dump, to make it span several chunks. */
    dumpFiller?: number;
    /** ORA- lines the export or the import writes into its log. */
    exportLogErrors?: string[];
    importLogErrors?: string[];
    /** The state WAIT_FOR_JOB returns. */
    exportState?: string;
    importState?: string;
    /** Errors the job blocks raise, like a missing privilege. */
    exportError?: Error;
    importError?: Error;
    /** The driver cannot read a BFILE itself, as older drivers could not. */
    bfileUnsupported?: boolean;
    /** Writing into the directory fails, like a path missing on the server. */
    writeError?: Error;
    /** The login and its roles. */
    login?: string;
    roles?: string[];
    /** DBA views are not readable for the login. */
    noDbaViews?: boolean;
    version?: string;
    /** Objects per schema that a recompile leaves invalid, as `TYPE NAME`. */
    invalidAfterCompile?: Record<string, string[]>;
    /** The recompile fails, like a login without ALTER ANY PROCEDURE. */
    compileError?: Error;
}

export interface ExecuteCall {
    kind: string;
    sql: string;
    binds: Record<string, unknown>;
}

export interface FakeOracle {
    files: Map<string, Buffer>;
    schemas: Map<string, Record<string, number>>;
    calls: ExecuteCall[];
    imports: { source: string; target: string; tableExistsAction: boolean; sha256: string }[];
    exports: { schema: string; consistent: boolean; job: string }[];
    /** The schemas DBMS_UTILITY.COMPILE_SCHEMA ran for, in order. */
    compiled: string[];
    closed: number;
    connection(): FakeConnection;
}

export interface FakeConnection {
    oracleServerVersionString: string;
    execute(sql: string, binds?: Record<string, unknown>, options?: Record<string, unknown>): Promise<{ rows?: unknown[]; outBinds?: Record<string, unknown> }>;
    close(): Promise<void>;
}

const MAGIC = "FAKEDUMP";

function key(directory: unknown, file: unknown): string {
    return `${String(directory)}/${String(file)}`;
}

function oraError(code: string, text: string): Error {
    return new Error(`${code}: ${text}`);
}

/** Filler that differs from byte to byte, so a chunk in the wrong place changes the content. */
function filler(size: number, seed: number): Buffer {
    const buffer = Buffer.alloc(size);
    let state = seed || 1;
    for (let i = 0; i < size; i++) {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        buffer[i] = state & 0xff;
    }
    return buffer;
}

export function encodeDump(schema: string, tables: Record<string, number>, fillerBytes: number): Buffer {
    const header = Buffer.from(`${MAGIC}${JSON.stringify({ schema, tables })}\n`, "utf8");
    return Buffer.concat([header, filler(fillerBytes, schema.length * 7919)]);
}

export function decodeDump(dump: Buffer): { schema: string; tables: Record<string, number> } {
    const text = dump.subarray(0, Math.min(dump.length, 64 * 1024)).toString("utf8");
    if (!text.startsWith(MAGIC)) throw oraError("ORA-39143", "dump file may be an original export dump file");
    return JSON.parse(text.slice(MAGIC.length, text.indexOf("\n")));
}

function schemaFromExpression(expression: unknown): string {
    const match = String(expression).match(/^IN \('((?:[^']|'')*)'\)$/);
    if (!match) throw oraError("ORA-39001", `invalid schema expression ${String(expression)}`);
    return match[1].replace(/''/g, "'");
}

function jobLog(job: string, kind: "exported" | "imported", schema: string, tables: Record<string, number>, errors: string[]): string {
    const lines = [`Starting "SYSTEM"."${job}":`];
    for (const [table, rows] of Object.entries(tables)) {
        lines.push(`. . ${kind} "${schema}"."${table}"    8.0 KB    ${rows} rows`);
    }
    lines.push(...errors);
    lines.push(errors.length
        ? `Job "SYSTEM"."${job}" completed with ${errors.length} error(s) at Fri Nov 6 21:00:00 2026 elapsed 0 00:00:02`
        : `Job "SYSTEM"."${job}" successfully completed at Fri Nov 6 21:00:00 2026 elapsed 0 00:00:02`);
    return `${lines.join("\n")}\n`;
}

export function createFakeOracle(options: FakeOracleOptions = {}): FakeOracle {
    const files = new Map<string, Buffer>();
    const schemas = new Map<string, Record<string, number>>(Object.entries(options.schemas ?? { HR: { EMPLOYEES: 107, DEPARTMENTS: 27 } }));
    const maintained = new Set(options.maintained ?? ["SYS", "SYSTEM"]);
    for (const name of maintained) if (!schemas.has(name)) schemas.set(name, {});
    const calls: ExecuteCall[] = [];
    const imports: FakeOracle["imports"] = [];
    const exports: FakeOracle["exports"] = [];
    const compiled: string[] = [];
    const login = options.login ?? "SYSTEM";

    const state = { closed: 0 };

    function readFile(directory: unknown, file: unknown): Buffer {
        const content = files.get(key(directory, file));
        if (!content) throw oraError("ORA-22288", `file or LOB operation GETLENGTH failed\nNo such file or directory`);
        return content;
    }

    async function execute(sql: string, binds: Record<string, unknown> = {}, _options: Record<string, unknown> = {}) {
        const record = (kind: string) => calls.push({ kind, sql, binds });

        if (sql.includes("DBMS_LOB.GETLENGTH(BFILENAME")) {
            record("size");
            return { rows: [[readFile(binds.p_dir, binds.p_file).length]] };
        }
        if (sql.includes("SELECT BFILENAME(")) {
            record("bfile");
            const content = readFile(binds.p_dir, binds.p_file);
            const lob = {
                destroyed: false,
                async getData(offset: number, amount: number) {
                    if (options.bfileUnsupported) throw new Error("NJS-155: operation is not supported on BFILE LOBs");
                    if (offset > content.length) return null;
                    return content.subarray(offset - 1, offset - 1 + amount);
                },
                destroy() {
                    this.destroyed = true;
                },
            };
            return { rows: [[lob]] };
        }
        if (sql.includes("DBMS_LOB.FILEOPEN")) {
            record("read-piece");
            const content = readFile(binds.p_dir, binds.p_file);
            const offset = Number(binds.p_offset);
            const amount = Number(binds.p_amount);
            if (amount > 32767) throw oraError("ORA-06502", "PL/SQL: numeric or value error: raw variable length too long");
            const data = offset > content.length ? null : content.subarray(offset - 1, offset - 1 + amount);
            return { outBinds: { p_data: data } };
        }
        if (sql.includes("UTL_FILE.FOPEN")) {
            record("write");
            if (options.writeError) throw options.writeError;
            const chunk = (binds.p_chunk as { val: Buffer }).val;
            const name = key(binds.p_dir, binds.p_file);
            if (binds.p_open_mode === "wb") files.set(name, Buffer.from(chunk));
            else if (binds.p_open_mode === "ab") files.set(name, Buffer.concat([files.get(name) ?? Buffer.alloc(0), chunk]));
            else throw oraError("ORA-29281", "invalid mode");
            return {};
        }
        if (sql.includes("UTL_FILE.FREMOVE")) {
            record("remove");
            if (!files.delete(key(binds.p_dir, binds.p_file))) throw oraError("ORA-29283", "invalid file operation");
            return {};
        }
        if (sql.includes("operation => 'EXPORT'")) {
            record("export");
            if (options.exportError) throw options.exportError;
            const schema = schemaFromExpression(binds.p_schema_expr);
            const tables = schemas.get(schema);
            if (!tables) throw oraError("ORA-39165", `Schema ${schema} was not found.`);
            exports.push({ schema, consistent: binds.p_consistent === 1, job: String(binds.p_job) });
            files.set(key(binds.p_dir, binds.p_dump_file), encodeDump(schema, tables, options.dumpFiller ?? 1024));
            files.set(key(binds.p_dir_log, binds.p_log_file), Buffer.from(jobLog(String(binds.p_job), "exported", schema, tables, options.exportLogErrors ?? [])));
            return { outBinds: { p_state: options.exportState ?? "COMPLETED" } };
        }
        if (sql.includes("operation => 'IMPORT'")) {
            record("import");
            if (options.importError) throw options.importError;
            const dumpBytes = readFile(binds.p_dir, binds.p_dump_file);
            const dump = decodeDump(dumpBytes);
            const source = String(binds.p_source);
            const target = String(binds.p_target);
            if (schemaFromExpression(binds.p_schema_expr) !== dump.schema || source !== dump.schema) {
                throw oraError("ORA-39168", `Object path ${source} was not found.`);
            }
            imports.push({
                source,
                target,
                tableExistsAction: sql.includes("'TABLE_EXISTS_ACTION', value => 'REPLACE'"),
                sha256: createHash("sha256").update(dumpBytes).digest("hex"),
            });
            schemas.set(target, { ...(schemas.get(target) ?? {}), ...dump.tables });
            files.set(key(binds.p_dir_log, binds.p_log_file), Buffer.from(jobLog(String(binds.p_job), "imported", target, dump.tables, options.importLogErrors ?? [])));
            return { outBinds: { p_state: options.importState ?? "COMPLETED" } };
        }
        if (sql.includes("DBMS_UTILITY.COMPILE_SCHEMA")) {
            record("compile");
            if (options.compileError) throw options.compileError;
            compiled.push(String(binds.p_schema));
            return {};
        }
        if (sql.includes("status = 'INVALID'")) {
            record("invalid");
            const invalid = options.invalidAfterCompile?.[String(binds.p_schema)] ?? [];
            return {
                rows: invalid.map((entry) => {
                    const [OBJECT_TYPE, OBJECT_NAME] = entry.split(" ");
                    return { OBJECT_TYPE, OBJECT_NAME };
                }),
            };
        }
        if (sql.includes("oracle_maintained = 'N'")) {
            record("schemas");
            return { rows: [...schemas.keys()].filter((name) => !maintained.has(name)).sort().map((USERNAME) => ({ USERNAME })) };
        }
        if (sql.includes("FROM all_users WHERE username = :p_schema")) {
            record("find-schema");
            const name = String(binds.p_schema);
            return { rows: schemas.has(name) ? [{ USERNAME: name, ORACLE_MAINTAINED: maintained.has(name) ? "Y" : "N" }] : [] };
        }
        if (sql.includes("SESSION_USER")) {
            record("login");
            return { rows: [{ LOGIN_NAME: login }] };
        }
        if (sql.includes("FROM session_roles")) {
            record("roles");
            return { rows: (options.roles ?? ["DATAPUMP_IMP_FULL_DATABASE"]).map((ROLE) => ({ ROLE })) };
        }
        if (sql.includes("FROM dba_segments")) {
            record("segments");
            if (options.noDbaViews) throw oraError("ORA-00942", "table or view does not exist");
            return { rows: [...schemas.entries()].map(([OWNER, tables]) => ({ OWNER, BYTES: Object.keys(tables).length * 65536 })) };
        }
        if (sql.includes("FROM dba_tables")) {
            record("dba-tables");
            return { rows: [...schemas.entries()].map(([OWNER, tables]) => ({ OWNER, TABLES: Object.keys(tables).length })) };
        }
        if (sql.includes("FROM all_tables GROUP BY owner")) {
            record("all-tables");
            return { rows: [...schemas.entries()].map(([OWNER, tables]) => ({ OWNER, TABLES: Object.keys(tables).length })) };
        }
        // The Database Explorer: every table has the columns ID, NAME, NOTES and PHOTO.
        if (sql.includes("FROM all_views")) {
            record("tables");
            const tables = schemas.get(String(binds.p_owner_tables)) ?? {};
            // Oracle pads the shorter literal of a UNION, which the adapter has to cope with.
            return { rows: [...Object.entries(tables).map(([NAME, ROW_COUNT]) => ({ NAME, ROW_COUNT, KIND: "table" })), { NAME: "V_SUMMARY", ROW_COUNT: null, KIND: "view " }] };
        }
        if (sql.includes("FROM all_tab_columns")) {
            record("columns");
            const tables = schemas.get(String(binds.p_owner)) ?? {};
            if (!(String(binds.p_table) in tables)) return { rows: [] };
            return {
                rows: [
                    { COLUMN_NAME: "ID", DATA_TYPE: "NUMBER", NULLABLE: "N", IS_PRIMARY: "Y" },
                    { COLUMN_NAME: "NAME", DATA_TYPE: "VARCHAR2", NULLABLE: "Y", IS_PRIMARY: "N" },
                    { COLUMN_NAME: "NOTES", DATA_TYPE: "CLOB", NULLABLE: "Y", IS_PRIMARY: "N" },
                    { COLUMN_NAME: "PHOTO", DATA_TYPE: "BLOB", NULLABLE: "Y", IS_PRIMARY: "N" },
                ],
            };
        }
        if (sql.startsWith("SELECT COUNT(*) FROM \"")) {
            record("count");
            return { rows: [[3]] };
        }
        if (sql.startsWith("SELECT * FROM \"")) {
            record("page");
            return {
                rows: [
                    { ID: 1, NAME: "Ada", NOTES: "first", PHOTO: Buffer.from([0xde, 0xad, 0xbe, 0xef]) },
                    { ID: 2, NAME: "Grace", NOTES: null, PHOTO: null },
                ],
            };
        }
        throw new Error(`The fake Oracle does not know this statement:\n${sql}`);
    }

    return {
        files,
        schemas,
        calls,
        imports,
        exports,
        compiled,
        get closed() {
            return state.closed;
        },
        connection(): FakeConnection {
            return {
                oracleServerVersionString: options.version ?? "23.6.0.24.10",
                execute,
                close: async () => {
                    state.closed++;
                },
            };
        },
    };
}
