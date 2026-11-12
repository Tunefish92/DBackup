import { describe, it, expect } from "vitest";
import { EXPORT_BLOCK, IMPORT_BLOCK, excerpt, keptObject, logDetails, reviewLog, schemaExpression } from "@/lib/adapters/database/oracle/datapump";

/** The bind names of a block, each with how often it appears. */
function bindCounts(block: string): Map<string, number> {
    const counts = new Map<string, number>();
    // Strip string literals first, a colon inside one is not a bind.
    for (const match of block.replace(/'[^']*'/g, "''").matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)) {
        counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
    }
    return counts;
}

describe("Data Pump blocks", () => {
    it.each([["export", EXPORT_BLOCK], ["import", IMPORT_BLOCK]])("uses every bind of the %s block exactly once, all prefixed", (_name, block) => {
        // Reserved words like :file or :mode fail with ORA-01745, and a bind repeated inside
        // PL/SQL is a question of driver behavior nobody should have to answer.
        const counts = bindCounts(block);
        expect(counts.size).toBeGreaterThan(0);
        for (const [name, count] of counts) {
            expect(name, `bind ${name}`).toMatch(/^p_/);
            expect(count, `bind ${name}`).toBe(1);
        }
    });

    it("pins an export to one point in time only when consistency is asked for", () => {
        expect(EXPORT_BLOCK).toMatch(/IF :p_consistent = 1 THEN\s+DBMS_DATAPUMP\.SET_PARAMETER\(handle => l_handle, name => 'FLASHBACK_TIME', value => 'SYSTIMESTAMP'\);/);
    });

    it("replaces existing tables on import and remaps only a renamed schema", () => {
        expect(IMPORT_BLOCK).toContain("name => 'TABLE_EXISTS_ACTION', value => 'REPLACE'");
        expect(IMPORT_BLOCK).toMatch(/IF l_source <> l_target THEN\s+DBMS_DATAPUMP\.METADATA_REMAP\(handle => l_handle, name => 'REMAP_SCHEMA'/);
    });

    it("stops a failed job and raises the reason Data Pump recorded", () => {
        for (const block of [EXPORT_BLOCK, IMPORT_BLOCK]) {
            expect(block).toContain("DBMS_DATAPUMP.KU$_STATUS_JOB_ERROR");
            expect(block).toContain("DBMS_DATAPUMP.STOP_JOB(handle => l_handle, immediate => 1, keep_master => 0)");
            expect(block).toContain("RAISE_APPLICATION_ERROR(-20001");
        }
    });

    it("filters a schema with its quotes doubled", () => {
        expect(schemaExpression("HR")).toBe("IN ('HR')");
        expect(schemaExpression("O'BRIEN")).toBe("IN ('O''BRIEN')");
    });
});

describe("Data Pump logs", () => {
    it("reads the closing line of a job that went well", () => {
        const review = reviewLog([
            "Starting \"SYSTEM\".\"DBACKUP_EXP_1\":",
            ". . exported \"HR\".\"EMPLOYEES\"   17.08 KB     107 rows",
            "Job \"SYSTEM\".\"DBACKUP_EXP_1\" successfully completed at Fri Nov 6 21:00:00 2026 elapsed 0 00:00:05",
        ].join("\n"));
        expect(review.summary).toMatch(/successfully completed/);
        expect(review.errors).toEqual([]);
        expect(review.dataLoss).toEqual([]);
    });

    it("counts objects that already exist as kept, and anything else as a warning, never as lost data", () => {
        const review = reviewLog([
            "ORA-31684: Object type USER:\"HR\" already exists",
            "ORA-31684: Object type SEQUENCE:\"HR\".\"EMP_SEQ\" already exists",
            "ORA-39111: Dependent object type ALTER_PROCEDURE:\"HR\".\"P\" skipped, base object type PROCEDURE:\"HR\".\"P\" already exists",
            "ORA-39082: Object type PROCEDURE:\"HR\".\"Q\" created with compilation warnings",
            "Job \"SYSTEM\".\"DBACKUP_IMP_1\" completed with 4 error(s) at Fri Nov 6 21:00:00 2026",
        ].join("\r\n"));
        expect(review.errors).toHaveLength(4);
        expect(review.kept).toHaveLength(3);
        expect(review.warnings).toEqual([expect.stringMatching(/^ORA-39082/)]);
        expect(review.dataLoss).toEqual([]);
        expect(review.summary).toMatch(/completed with 4 error/);
    });

    it("names a kept object by its type and name, and a dependent step by the object it belongs to", () => {
        expect(keptObject("ORA-31684: Object type SEQUENCE:\"SHOP\".\"INVOICE_NUMBER\" already exists")).toBe("SEQUENCE \"SHOP\".\"INVOICE_NUMBER\"");
        expect(keptObject("ORA-31684: Object type USER:\"SHOP\" already exists")).toBe("USER \"SHOP\"");
        expect(keptObject("ORA-39111: Dependent object type ALTER_PROCEDURE:\"SHOP\".\"MARK_PAID\" skipped, base object type PROCEDURE:\"SHOP\".\"MARK_PAID\" already exists")).toBe("PROCEDURE \"SHOP\".\"MARK_PAID\"");
    });

    it("flags rows or tables that did not make it", () => {
        const review = reviewLog([
            "ORA-31693: Table data object \"HR\".\"EMPLOYEES\" failed to load/unload and is being skipped due to error:",
            "ORA-01555: snapshot too old: rollback segment number 2 with name \"_SYSSMU2$\" too small",
            "ORA-39083: Object type TABLE:\"HR\".\"JOBS\" failed to create with error:",
            "ORA-39083: Object type OBJECT_GRANT failed to create with error:",
            "ORA-39126: Worker unexpected fatal error in KUPW$WORKER.MAIN",
        ].join("\n"));
        expect(review.dataLoss).toEqual([
            expect.stringMatching(/^ORA-31693/),
            expect.stringMatching(/^ORA-39083: Object type TABLE:/),
            expect.stringMatching(/^ORA-39126/),
        ]);
    });

    it("keeps only the end of a very long log", () => {
        expect(logDetails("")).toBeUndefined();
        const long = "x".repeat(100_000);
        expect(logDetails(long, 1000)).toHaveLength(1000 + 4);
        expect(excerpt(["a", "b", "c"], 2)).toBe("a\nb\n... and 1 more");
    });
});
