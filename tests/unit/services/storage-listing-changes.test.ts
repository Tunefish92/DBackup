import { describe, it, expect } from "vitest";
import { isRewritten, listingChanges } from "@/services/storage/listing-changes";

const at = "2026-10-22T11:52:00.000Z";
const later = "2026-10-22T11:57:00.000Z";
const file = (path: string, size: number, lastModified: string) => ({ name: path.split("/").at(-1)!, path, size, lastModified: new Date(lastModified) });

describe("a backup written again under its path", () => {
    it("counts as written again when its size or its time on the storage changed", () => {
        expect(isRewritten(file("a.tar", 10, later), { path: "a.tar", size: 10, lastModified: at })).toBe(true);
        expect(isRewritten(file("a.tar", 12, at), { path: "a.tar", size: 10, lastModified: at })).toBe(true);
        expect(isRewritten(file("a.tar", 10, at), { path: "a.tar", size: 10, lastModified: new Date(at) })).toBe(false);
    });

    it("is not told by a time either side cannot read", () => {
        expect(isRewritten(file("a.tar", 10, at), { path: "a.tar", size: 10, lastModified: "not a date" })).toBe(false);
    });
});

describe("what a reconciliation changes", () => {
    it("reads again the backups that are new or written again, and drops the ones gone", () => {
        const cached = [
            { path: "mysql/clienti/mysql_clienti.tar", size: 10, lastModified: at },
            { path: "mysql/old.tar", size: 5, lastModified: at },
            { path: "mysql/same.tar", size: 7, lastModified: at },
        ];
        const remote = [
            file("mysql/clienti/mysql_clienti.tar", 10, later),
            file("mysql/same.tar", 7, at),
            file("mysql/new.tar", 3, later),
        ];

        const { removedPaths, freshFiles } = listingChanges(cached, remote);

        expect([...removedPaths]).toEqual(["mysql/old.tar"]);
        expect(freshFiles.map((f) => f.path)).toEqual(["mysql/clienti/mysql_clienti.tar", "mysql/new.tar"]);
    });
});
