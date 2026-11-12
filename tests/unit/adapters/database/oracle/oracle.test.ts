// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";

const { getConnection, server } = vi.hoisted(() => {
    const server: { current: import("./fake-oracle").FakeOracle | null } = { current: null };
    const getConnection = vi.fn(async (_attributes: Record<string, unknown>) => {
        if (!server.current) throw new Error("no fake server");
        return server.current.connection();
    });
    return { getConnection, server };
});

vi.mock("oracledb", () => {
    const api = {
        getConnection,
        OUT_FORMAT_ARRAY: 4001,
        OUT_FORMAT_OBJECT: 4002,
        BIND_IN: 3001,
        BIND_OUT: 3003,
        STRING: 2001,
        BUFFER: 2006,
        BLOB: 2019,
        DB_TYPE_CLOB: { name: "DB_TYPE_CLOB" },
        DB_TYPE_NCLOB: { name: "DB_TYPE_NCLOB" },
        DB_TYPE_BLOB: { name: "DB_TYPE_BLOB" },
    };
    return { default: api, ...api };
});

import { createFakeHost } from "@/lib/testing/fake-host";
import type { HostKind } from "@/lib/transport/types";
import { OracleSchema, type OracleConfig } from "@/lib/adapters/definitions";
import { getDatabases, getDatabasesWithStats, ping, test as testConnection } from "@/lib/adapters/database/oracle/connection";
import { dump, dumpOne } from "@/lib/adapters/database/oracle/dump";
import { prepareRestore, restore, restoreOne } from "@/lib/adapters/database/oracle/restore";
import { DOWNLOAD_CHUNK_BYTES, UPLOAD_CHUNK_BYTES } from "@/lib/adapters/database/oracle/files";
import { getTableData, getTables } from "@/lib/adapters/database/oracle/browser";
import { listInvalid } from "@/lib/adapters/database/oracle/recompile";
import { createFakeOracle, encodeDump, type FakeOracleOptions } from "./fake-oracle";

const baseConfig = OracleSchema.parse({
    host: "ora.internal",
    port: 1521,
    serviceName: "FREEPDB1",
    user: "system",
    password: "secret",
}) as OracleConfig;

function useServer(options: FakeOracleOptions = {}) {
    server.current = createFakeOracle(options);
    return server.current;
}

function lastConnectString(): string {
    return String((getConnection.mock.calls.at(-1)?.[0] as Record<string, unknown>).connectString);
}

let workDir: string;

beforeEach(async () => {
    getConnection.mockClear();
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "dbackup-oracle-test-"));
});

afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
});

const sha256 = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");

describe.each(["direct", "ssh"] as HostKind[])("Oracle connection test (%s)", (kind) => {
    it("logs in through the transport, writes and removes a file in the directory, and reports the version", async () => {
        const fake = useServer();
        const host = createFakeHost({ kind });

        const result = await testConnection(baseConfig, host);

        expect(result).toEqual({
            success: true,
            message: `Connection successful${kind === "ssh" ? " (via SSH)" : ""}`,
            version: "23.6.0.24.10",
        });
        expect(host.calls.forwards).toEqual([{ host: "ora.internal", port: 1521 }]);
        expect(lastConnectString()).toBe(kind === "ssh" ? "127.0.0.1:15001/FREEPDB1" : "ora.internal:1521/FREEPDB1");
        expect(fake.calls.map((call) => call.kind)).toEqual(["write", "size", "remove"]);
        expect(fake.files.size).toBe(0);
        expect(fake.closed).toBe(1);
    });

    it("fails with Oracle's reason when the directory cannot be written", async () => {
        useServer({ writeError: new Error("ORA-29280: invalid directory object\nORA-06512: at \"SYS.UTL_FILE\", line 41") });

        const result = await testConnection(baseConfig, createFakeHost({ kind }));

        expect(result.success).toBe(false);
        expect(result.message).toBe("Connected, but the directory DATA_PUMP_DIR is not usable: writing failed (ORA-29280: invalid directory object)");
        expect(result.version).toBe("23.6.0.24.10");
    });

    it("pings the listener port without logging in", async () => {
        useServer();
        const host = createFakeHost({ kind });

        await expect(ping(baseConfig, host)).resolves.toEqual({ success: true, message: `Connection successful${kind === "ssh" ? " (via SSH)" : ""}` });
        expect(getConnection).not.toHaveBeenCalled();
    });
});

describe("Oracle connection settings", () => {
    it("connects with TCPS when TLS is on", async () => {
        useServer();
        await testConnection({ ...baseConfig, tls: true }, createFakeHost({ kind: "direct" }));
        expect(lastConnectString()).toBe("tcps://ora.internal:1521/FREEPDB1");
    });

    it("refuses TLS through an SSH tunnel instead of checking a certificate against 127.0.0.1", async () => {
        useServer();
        const result = await testConnection({ ...baseConfig, tls: true }, createFakeHost({ kind: "ssh" }));
        expect(result.success).toBe(false);
        expect(result.message).toMatch(/TLS cannot be checked through an SSH tunnel/);
        expect(getConnection).not.toHaveBeenCalled();
    });

    it("keeps the timeout and keepalive on the connection, so a long export is not dropped as idle", async () => {
        useServer();
        await testConnection(baseConfig, createFakeHost());
        expect(getConnection.mock.calls[0][0]).toMatchObject({ user: "system", password: "secret", connectTimeout: 15, expireTime: 1 });
    });

    it("lists only the schemas Oracle did not create itself", async () => {
        useServer({ schemas: { HR: {}, SHOP: {}, APEX_230200: {} }, maintained: ["SYS", "SYSTEM", "APEX_230200"] });
        await expect(getDatabases(baseConfig, createFakeHost())).resolves.toEqual(["HR", "SHOP"]);
    });

    it("falls back to the tables the login sees when it cannot read the DBA views", async () => {
        useServer({ schemas: { HR: { A: 1, B: 2 } }, noDbaViews: true });
        await expect(getDatabasesWithStats(baseConfig, createFakeHost())).resolves.toEqual([{ name: "HR", sizeInBytes: 0, tableCount: 2 }]);
    });

    it("closes the connection when a call fails halfway", async () => {
        const fake = useServer();
        await expect(dumpOne(baseConfig, "NOPE", path.join(workDir, "x.dmp"), createFakeHost())).rejects.toThrow(/Schema NOPE does not exist/);
        expect(fake.closed).toBe(1);
    });
});

describe.each(["direct", "ssh"] as HostKind[])("Oracle backup (%s)", (kind) => {
    it("copies the whole dump of a schema over several chunks and leaves nothing on the server", async () => {
        const filler = 2 * DOWNLOAD_CHUNK_BYTES + 12345;
        const fake = useServer({ dumpFiller: filler });
        const destination = path.join(workDir, "0001.dmp");
        const host = createFakeHost({ kind });

        const result = await dumpOne(baseConfig, "HR", destination, host);

        const written = await fs.readFile(destination);
        expect(written.equals(encodeDump("HR", { EMPLOYEES: 107, DEPARTMENTS: 27 }, filler))).toBe(true);
        expect(result.size).toBe(written.length);
        expect(fake.exports).toEqual([{ schema: "HR", consistent: true, job: expect.stringMatching(/^DBACKUP_EXP_/) }]);
        expect(fake.files.size).toBe(0);
        expect(host.calls.forwards).toHaveLength(1);
    });
});

describe("Oracle backup", () => {
    it("exports without a flashback time when consistency is off", async () => {
        const fake = useServer();
        await dumpOne({ ...baseConfig, consistent: false }, "HR", path.join(workDir, "a.dmp"), createFakeHost());
        expect(fake.exports[0].consistent).toBe(false);
    });

    it("treats a stored config without the consistency switch as consistent", async () => {
        const fake = useServer();
        const { consistent: _omitted, ...stored } = baseConfig;
        await dumpOne(stored as OracleConfig, "HR", path.join(workDir, "a.dmp"), createFakeHost());
        expect(fake.exports[0].consistent).toBe(true);
    });

    it("refuses one of Oracle's own schemas", async () => {
        useServer();
        await expect(dumpOne(baseConfig, "SYSTEM", path.join(workDir, "a.dmp"), createFakeHost())).rejects.toThrow(/belongs to Oracle itself/);
    });

    it("fails a backup whose log reports a table that could not be exported, and still cleans up", async () => {
        const fake = useServer({
            exportLogErrors: [
                "ORA-31693: Table data object \"HR\".\"EMPLOYEES\" failed to load/unload and is being skipped due to error:",
                "ORA-01555: snapshot too old",
            ],
        });
        await expect(dumpOne(baseConfig, "HR", path.join(workDir, "a.dmp"), createFakeHost())).rejects.toThrow(/could not export all data of HR:\nORA-31693/);
        expect(fake.files.size).toBe(0);
    });

    it("fails a backup whose job did not complete", async () => {
        const fake = useServer({ exportState: "STOPPED" });
        await expect(dumpOne(baseConfig, "HR", path.join(workDir, "a.dmp"), createFakeHost())).rejects.toThrow(/ended as STOPPED/);
        expect(fake.files.size).toBe(0);
    });

    it("passes on the reason a job could not start", async () => {
        useServer({ exportError: new Error("ORA-20001: ORA-39001: invalid argument value\nORA-39070: Unable to open the log file.") });
        await expect(dumpOne(baseConfig, "HR", path.join(workDir, "a.dmp"), createFakeHost())).rejects.toThrow(/ORA-39070: Unable to open the log file/);
    });

    it("keeps a backup with warnings and says so", async () => {
        useServer({ exportLogErrors: ["ORA-39173: Encrypted data has been stored unencrypted in dump file set."] });
        const onLog = vi.fn();
        await dumpOne(baseConfig, "HR", path.join(workDir, "a.dmp"), createFakeHost(), onLog);
        expect(onLog).toHaveBeenCalledWith("Data Pump reported 1 warning(s) for HR", "warning", "general", expect.stringContaining("ORA-39173"));
    });

    it("reads through PL/SQL when the driver cannot read a BFILE, with the same bytes", async () => {
        const filler = 100_000;
        const fake = useServer({ bfileUnsupported: true, dumpFiller: filler });
        const destination = path.join(workDir, "a.dmp");

        await dumpOne(baseConfig, "HR", destination, createFakeHost());

        expect((await fs.readFile(destination)).equals(encodeDump("HR", { EMPLOYEES: 107, DEPARTMENTS: 27 }, filler))).toBe(true);
        expect(fake.calls.filter((call) => call.kind === "read-piece").length).toBeGreaterThan(3);
    });

    it("writes one selected schema through the older dump() entry point", async () => {
        useServer();
        const result = await dump({ ...baseConfig, database: ["HR"] }, path.join(workDir, "a.dmp"), createFakeHost());
        expect(result.success).toBe(true);
        const several = await dump({ ...baseConfig, database: "HR,SHOP" }, path.join(workDir, "b.dmp"), createFakeHost());
        expect(several.success).toBe(false);
    });

    it("binds every value with a p_ prefix, since names like :file are reserved in Oracle", async () => {
        const fake = useServer();
        await dumpOne(baseConfig, "HR", path.join(workDir, "a.dmp"), createFakeHost());
        for (const call of fake.calls) {
            for (const name of Object.keys(call.binds)) expect(name, `${call.kind}: ${name}`).toMatch(/^p_/);
        }
    });
});

describe.each(["direct", "ssh"] as HostKind[])("Oracle restore (%s)", (kind) => {
    it("uploads the dump byte for byte, imports it under the new name and leaves nothing on the server", async () => {
        const fake = useServer({ schemas: { HR: { EMPLOYEES: 107 } } });
        const local = path.join(workDir, "restore.dmp");
        const bytes = encodeDump("HR", { EMPLOYEES: 107, JOBS: 19 }, 2 * UPLOAD_CHUNK_BYTES + 777);
        await fs.writeFile(local, bytes);
        const progress: number[] = [];

        await restoreOne(baseConfig, local, "HR_COPY", createFakeHost({ kind }), undefined, (percent) => progress.push(percent), "HR");

        expect(fake.imports).toEqual([{ source: "HR", target: "HR_COPY", tableExistsAction: true, sha256: sha256(bytes) }]);
        expect(fake.schemas.get("HR_COPY")).toEqual({ EMPLOYEES: 107, JOBS: 19 });
        expect(fake.calls.filter((call) => call.kind === "write")).toHaveLength(3);
        expect(fake.files.size).toBe(0);
        expect(progress.at(-1)).toBe(100);
        expect(progress).toEqual([...progress].sort((a, b) => a - b));
    });
});

describe("Oracle restore", () => {
    async function dumpFile(schema = "HR"): Promise<string> {
        const local = path.join(workDir, `${schema}.dmp`);
        await fs.writeFile(local, encodeDump(schema, { EMPLOYEES: 107 }, 64));
        return local;
    }

    it("restores into the same schema without remapping", async () => {
        const fake = useServer();
        await restoreOne(baseConfig, await dumpFile(), "HR", createFakeHost(), undefined, undefined, "HR");
        expect(fake.imports[0]).toMatchObject({ source: "HR", target: "HR" });
    });

    it("creates a new schema typed in lower case under its upper case name", async () => {
        const fake = useServer();
        const onLog = vi.fn();
        await restoreOne(baseConfig, await dumpFile(), "hr_copy", createFakeHost(), onLog, undefined, "HR");
        expect(fake.imports[0]).toMatchObject({ target: "HR_COPY" });
        expect(onLog).toHaveBeenCalledWith("Restoring into schema HR_COPY, the name hr_copy as Oracle stores it");
    });

    it("refuses to restore into one of Oracle's own schemas", async () => {
        const fake = useServer();
        await expect(restoreOne(baseConfig, await dumpFile(), "SYSTEM", createFakeHost(), undefined, undefined, "HR")).rejects.toThrow(/belongs to Oracle itself/);
        expect(fake.imports).toEqual([]);
    });

    it("restores over an existing schema without a warning for the objects it keeps", async () => {
        useServer({
            importLogErrors: [
                "ORA-31684: Object type USER:\"HR\" already exists",
                "ORA-39111: Dependent object type ALTER_PROCEDURE:\"HR\".\"P\" skipped, base object type PROCEDURE:\"HR\".\"P\" already exists",
            ],
        });
        const onLog = vi.fn();
        await restoreOne(baseConfig, await dumpFile(), "HR", createFakeHost(), onLog, undefined, "HR");
        expect(onLog.mock.calls.filter((call) => call[1] === "warning")).toEqual([]);
    });

    it("still warns about anything else Data Pump reports", async () => {
        useServer({ importLogErrors: ["ORA-31684: Object type USER:\"HR\" already exists", "ORA-39082: Object type PROCEDURE:\"HR\".\"Q\" created with compilation warnings"] });
        const onLog = vi.fn();
        await restoreOne(baseConfig, await dumpFile(), "HR", createFakeHost(), onLog, undefined, "HR");
        const warnings = onLog.mock.calls.filter((call) => call[1] === "warning");
        expect(warnings).toHaveLength(1);
        expect(warnings[0][3]).toMatch(/^ORA-39082/);
    });

    it("recompiles the target schema after the import, so kept views and procedures are not left invalid", async () => {
        const fake = useServer();
        await restoreOne(baseConfig, await dumpFile(), "hr_copy", createFakeHost(), undefined, undefined, "HR");
        expect(fake.compiled).toEqual(["HR_COPY"]);
        expect(fake.calls.map((call) => call.kind).indexOf("compile")).toBeGreaterThan(fake.calls.map((call) => call.kind).indexOf("import"));
    });

    it("still restores when the login may not recompile, and cleans up", async () => {
        const fake = useServer({ compileError: new Error("ORA-20000: Insufficient privileges for some object in this schema") });
        await restoreOne(baseConfig, await dumpFile(), "HR", createFakeHost(), undefined, undefined, "HR");
        expect(fake.imports).toHaveLength(1);
        expect(fake.compiled).toEqual([]);
        expect(fake.files.size).toBe(0);
    });

    it("still restores when objects stay invalid after the recompile", async () => {
        const fake = useServer({ invalidAfterCompile: { HR: ["VIEW EMP_DETAILS", "PROCEDURE RAISE_SALARY"] } });
        await restoreOne(baseConfig, await dumpFile(), "HR", createFakeHost(), undefined, undefined, "HR");
        expect(fake.compiled).toEqual(["HR"]);
        expect(fake.files.size).toBe(0);
    });

    it("fails when rows could not be loaded, and removes the uploaded dump", async () => {
        const fake = useServer({ importLogErrors: ["ORA-31693: Table data object \"HR\".\"EMPLOYEES\" failed to load/unload and is being skipped due to error:"] });
        await expect(restoreOne(baseConfig, await dumpFile(), "HR", createFakeHost(), undefined, undefined, "HR")).rejects.toThrow(/could not import all data into HR/);
        expect(fake.files.size).toBe(0);
    });

    it("restores through the older restore() entry point with a database mapping", async () => {
        const fake = useServer();
        const result = await restore(
            { ...baseConfig, databaseMapping: [{ originalName: "HR", targetName: "HR_OLD", selected: true }] },
            await dumpFile(),
            createFakeHost(),
        );
        expect(result.success).toBe(true);
        expect(fake.imports[0]).toMatchObject({ source: "HR", target: "HR_OLD" });
    });

    it("lets a login without the import role restore only into its own schema", async () => {
        useServer({ login: "HR", roles: [], schemas: { HR: {}, SHOP: {} } });
        await expect(prepareRestore({ ...baseConfig, user: "hr" }, ["HR"], createFakeHost())).resolves.toBeUndefined();
        await expect(prepareRestore({ ...baseConfig, user: "hr" }, ["SHOP"], createFakeHost())).rejects.toThrow(/needs the role DATAPUMP_IMP_FULL_DATABASE/);
    });

    it("lets a login with the import role restore into any schema of its own making", async () => {
        useServer();
        await expect(prepareRestore(baseConfig, ["HR", "new_one"], createFakeHost())).resolves.toBeUndefined();
        await expect(prepareRestore(baseConfig, ["SYS"], createFakeHost())).rejects.toThrow(/belongs to Oracle itself/);
    });
});

describe("Oracle objects left invalid after a restore", () => {
    it("names the first twenty and counts the rest, so a large schema keeps the warning short", () => {
        const invalid = Array.from({ length: 23 }, (_, index) => `VIEW V${index + 1}`);
        const listed = listInvalid(invalid).split("\n");
        expect(listed).toHaveLength(21);
        expect(listed[19]).toBe("VIEW V20");
        expect(listed[20]).toBe("...and 3 more");
        expect(listInvalid(["PROCEDURE P"])).toBe("PROCEDURE P");
    });
});

describe("Oracle Database Explorer", () => {
    it("lists tables and views, with the padded kind of a UNION read correctly", async () => {
        useServer({ schemas: { HR: { EMPLOYEES: 107 } } });
        await expect(getTables(baseConfig, "HR", createFakeHost())).resolves.toEqual([
            { name: "EMPLOYEES", type: "table", rowCount: 107 },
            { name: "V_SUMMARY", type: "view", rowCount: undefined },
        ]);
    });

    it("pages through a table with quoted names, bound search terms and a checked sort column", async () => {
        const fake = useServer({ schemas: { HR: { EMPLOYEES: 107 } } });

        const result = await getTableData(baseConfig, {
            database: "HR", table: "EMPLOYEES", page: 3, pageSize: 25, search: "Ad", searchColumn: "NAME", matchMode: "starts", sortBy: "ID", sortDir: "desc",
        }, createFakeHost());

        const page = fake.calls.find((call) => call.kind === "page")!;
        expect(page.sql).toBe("SELECT * FROM \"HR\".\"EMPLOYEES\" WHERE TO_CHAR(\"NAME\") LIKE :p_search ORDER BY \"ID\" DESC OFFSET :p_offset ROWS FETCH NEXT :p_limit ROWS ONLY");
        expect(page.binds).toEqual({ p_search: "Ad%", p_offset: 50, p_limit: 25 });
        expect(result.totalCount).toBe(3);
        expect(result.columns.map((column) => column.name)).toEqual(["ID", "NAME", "NOTES", "PHOTO"]);
        expect(result.rows[0]).toEqual({ ID: 1, NAME: "Ada", NOTES: "first", PHOTO: "0xDEADBEEF" });
    });

    it("ignores a sort column the table does not have", async () => {
        const fake = useServer({ schemas: { HR: { EMPLOYEES: 107 } } });
        await getTableData(baseConfig, { database: "HR", table: "EMPLOYEES", page: 1, pageSize: 10, sortBy: "ID\" DESC; DROP TABLE x --" }, createFakeHost());
        expect(fake.calls.find((call) => call.kind === "page")!.sql).not.toContain("ORDER BY");
    });

    it("refuses a table the dictionary does not know", async () => {
        useServer({ schemas: { HR: { EMPLOYEES: 107 } } });
        await expect(getTableData(baseConfig, { database: "HR", table: "SALARIES", page: 1, pageSize: 10 }, createFakeHost())).rejects.toThrow(/does not exist/);
    });

    it("refuses to search a binary column", async () => {
        useServer({ schemas: { HR: { EMPLOYEES: 107 } } });
        await expect(getTableData(baseConfig, { database: "HR", table: "EMPLOYEES", page: 1, pageSize: 10, search: "x", searchColumn: "PHOTO" }, createFakeHost())).rejects.toThrow(/binary data/);
    });
});
