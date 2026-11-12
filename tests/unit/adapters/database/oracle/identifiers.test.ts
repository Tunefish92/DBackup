import { describe, it, expect } from "vitest";
import {
    assertSchemaName,
    connectString,
    directoryName,
    newSchemaName,
    probeFileName,
    quoteIdentifier,
    quoteLiteral,
    runNames,
} from "@/lib/adapters/database/oracle/identifiers";

describe("Oracle directory objects", () => {
    it("uses DATA_PUMP_DIR when none is configured", () => {
        expect(directoryName(undefined)).toBe("DATA_PUMP_DIR");
        expect(directoryName("  ")).toBe("DATA_PUMP_DIR");
    });

    it("looks up a lower case directory by the upper case name Oracle stores", () => {
        expect(directoryName("dbackup_dir")).toBe("DBACKUP_DIR");
    });

    it("refuses a directory that is not a plain Oracle name", () => {
        expect(() => directoryName("DIR'); DROP USER x; --")).toThrow(/not a valid Oracle name/);
        expect(() => directoryName("1DIR")).toThrow(/not a valid Oracle name/);
        expect(() => directoryName("/u01/dpdump")).toThrow(/not a valid Oracle name/);
    });
});

describe("Oracle schema names", () => {
    it("upper-cases a new schema typed in lower case, like SQL*Plus would", () => {
        expect(newSchemaName("hr_copy")).toBe("HR_COPY");
        expect(newSchemaName(" hr_copy ")).toBe("HR_COPY");
    });

    it("keeps a schema name in mixed or upper case as it is", () => {
        expect(newSchemaName("HrCopy")).toBe("HrCopy");
        expect(newSchemaName("HR_COPY")).toBe("HR_COPY");
        expect(newSchemaName("hr copy")).toBe("hr copy");
    });

    it("refuses a name Oracle cannot quote", () => {
        expect(() => assertSchemaName("a\"b")).toThrow(/not a valid Oracle schema name/);
        expect(() => assertSchemaName("")).toThrow(/not a valid Oracle schema name/);
        expect(() => assertSchemaName("x".repeat(129))).toThrow(/not a valid Oracle schema name/);
    });

    it("quotes identifiers and literals", () => {
        expect(quoteIdentifier("HR")).toBe("\"HR\"");
        expect(quoteLiteral("O'BRIEN")).toBe("'O''BRIEN'");
        expect(() => quoteIdentifier("x\"y")).toThrow();
    });
});

describe("Oracle connect strings", () => {
    it("builds an Easy Connect string from host, port and service", () => {
        expect(connectString("db.internal", 1521, "FREEPDB1", false)).toBe("db.internal:1521/FREEPDB1");
    });

    it("switches to TCPS for TLS", () => {
        expect(connectString("db.internal", 2484, "ORCLPDB1", true)).toBe("tcps://db.internal:2484/ORCLPDB1");
    });

    it("puts an IPv6 address in brackets", () => {
        expect(connectString("::1", 1521, "FREE", false)).toBe("[::1]:1521/FREE");
        expect(connectString("[fd00::5]", 1521, "FREE", false)).toBe("[fd00::5]:1521/FREE");
    });

    it("refuses a host or service that could smuggle in a connect descriptor", () => {
        expect(() => connectString("db)(HOST=evil", 1521, "FREE", false)).toThrow(/not a valid host/);
        expect(() => connectString("db", 1521, "FREE?ssl_server_dn_match=no", false)).toThrow(/Service name/);
    });
});

describe("Oracle run names", () => {
    it("names a job within the 30 characters of Oracle 12.1", () => {
        const names = runNames("EXP");
        expect(names.job).toMatch(/^DBACKUP_EXP_[0-9A-F]{12}$/);
        expect(names.job.length).toBeLessThanOrEqual(30);
        expect(names.dumpFile).toMatch(/^dbackup_exp_[0-9a-f]{12}\.dmp$/);
        expect(names.logFile).toBe(names.dumpFile.replace(/\.dmp$/, ".log"));
    });

    it("gives two runs different files, so jobs side by side never share one", () => {
        expect(runNames("IMP").dumpFile).not.toBe(runNames("IMP").dumpFile);
        expect(probeFileName()).not.toBe(probeFileName());
    });
});
