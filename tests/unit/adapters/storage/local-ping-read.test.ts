// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { LocalFileSystemAdapter } from "@/lib/adapters/storage/local";

let folder = "";

afterEach(async () => {
    if (folder) {
        await fs.chmod(folder, 0o755);
        await fs.rm(folder, { recursive: true, force: true });
        folder = "";
    }
});

describe("the health check of a local folder", () => {
    it("passes a folder DBackup may only read when it is a directory source, and fails it as a destination", async () => {
        folder = await fs.mkdtemp(path.join(os.tmpdir(), "dbackup-ro-"));
        await fs.chmod(folder, 0o555);
        // root writes into any folder, so the check means nothing there.
        const isRoot = process.getuid?.() === 0;

        await expect(LocalFileSystemAdapter.pingRead!({ basePath: folder })).resolves.toMatchObject({ success: true });
        if (!isRoot) {
            await expect(LocalFileSystemAdapter.ping!({ basePath: folder })).resolves.toMatchObject({ success: false });
        }
    });

    it("fails a folder that is not there for a source too", async () => {
        await expect(LocalFileSystemAdapter.pingRead!({ basePath: path.join(os.tmpdir(), "dbackup-missing-folder-x") })).resolves.toMatchObject({ success: false });
    });
});
