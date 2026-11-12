import { describe, it, expect } from "vitest";
import { ntStatuses, parseSmbDir, parseSmbDirRow } from "@/lib/adapters/storage/smb-listing";

/** A row the way smbclient prints it, `%-30s%7.7s %8.0f  %s`. */
function row(name: string, attributes: string, size: number, time = "Sat Oct 10 03:56:09 2026"): string {
    return `  ${name.padEnd(30)}${attributes.padStart(7)} ${String(size).padStart(8)}  ${time}`;
}

describe("the rows of smbclient's dir", () => {
    it("reads the rows samba-client drops: a long name with two flags, three flags and a lower-case flag", () => {
        const output = [
            row(".", "D", 0),
            row("h.tar", "AH", 5),
            row("Long_hidden_backup_name_2026-10-10_full.tar", "AH", 5),
            row("Critical_Backups_2026-10-10_01-20-00_full-000.tar", "A", 5),
            row("system.tar", "AHS", 12),
            row("indexed off", "Dn", 0),
            row("archive.tar", "An", 123456789012),
            "",
            "\t\t123456 blocks of size 1024. 7890 blocks available",
        ].join("\n");

        expect(parseSmbDir(output).map((entry) => [entry.name, entry.type, entry.size])).toEqual([
            [".", "D", 0],
            ["h.tar", "AH", 5],
            ["Long_hidden_backup_name_2026-10-10_full.tar", "AH", 5],
            ["Critical_Backups_2026-10-10_01-20-00_full-000.tar", "A", 5],
            ["system.tar", "AHS", 12],
            ["indexed off", "Dn", 0],
            ["archive.tar", "An", 123456789012],
        ]);
    });

    it("keeps the spaces inside a name and reads its time as UTC, like samba-client", () => {
        const entry = parseSmbDirRow(row("My Backups  2026", "D", 0, "Thu Oct  1 07:05:00 2026"));

        expect(entry).toEqual({ name: "My Backups  2026", type: "D", size: 0, modifyTime: new Date("2026-10-01T07:05:00Z") });
    });

    it("reads a name of exactly 30 characters and a row without attributes", () => {
        expect(parseSmbDirRow(row("a".repeat(30), "AH", 1))?.name).toBe("a".repeat(30));
        expect(parseSmbDirRow(row("plain.tar", "", 1))).toMatchObject({ name: "plain.tar", type: "" });
    });

    it("reads a line from Windows with its carriage return", () => {
        expect(parseSmbDirRow(`${row("x.tar", "A", 3)}\r`)?.name).toBe("x.tar");
    });

    it("is no entry for a line of another shape", () => {
        expect(parseSmbDirRow("NT_STATUS_ACCESS_DENIED listing \\\\*")).toBeNull();
        expect(parseSmbDirRow("  x.tar  A 3  yesterday")).toBeNull();
    });
});

describe("the status codes of an answer", () => {
    it("finds each NT_STATUS in the output", () => {
        expect(ntStatuses("NT_STATUS_ACCESS_DENIED making remote directory \\a\\b")).toEqual(["NT_STATUS_ACCESS_DENIED"]);
        expect(ntStatuses("all fine")).toEqual([]);
    });
});
