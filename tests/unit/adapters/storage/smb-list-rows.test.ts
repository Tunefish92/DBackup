// @vitest-environment node
import { describe, it, expect, vi } from "vitest";

/** A row the way smbclient prints it, `%-30s%7.7s %8.0f  %s`. */
function row(name: string, attributes: string, size: number): string {
    return `  ${name.padEnd(30)}${attributes.padStart(7)} ${String(size).padStart(8)}  Sat Oct 10 03:56:09 2026`;
}

/** The share root, with the rows samba-client used to drop. */
const DIR = [
    row(".", "D", 0),
    row("..", "D", 0),
    row("Long_hidden_backup_name_2026-10-10_full.tar", "AH", 5),
    row("system.tar", "AHS", 12),
    row("Long_folder_name_over_thirty_chars_x", "DH", 0),
    "",
    "\t\t976236212 blocks of size 1024. 669936836 blocks available",
].join("\n");

const NESTED = row("inner.tar", "An", 7);

// smbclient itself: the share root holds the rows above, the long folder one file.
const commands = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/adapters/storage/smb-run", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/adapters/storage/smb-run")>()),
    runSmbclient: async (args: string[]) => {
        const command = args[args.indexOf("-c") + 1] ?? "";
        commands.push(command);
        return /Long_folder_name_over_thirty_chars_x[\\/]/.test(command) ? NESTED : DIR;
    },
}));
vi.mock("@/lib/adapters/storage/smb-pin", () => ({ smbAddressOptions: async () => [] }));
vi.mock("@/lib/logging/logger", () => ({
    logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const { SMBAdapter } = await import("@/lib/adapters/storage/smb");

describe("the listing of an SMB share", () => {
    it("reads every row smbclient prints and walks into the folder samba-client used to drop", async () => {
        const files = await SMBAdapter.list({ address: "//files.example.com/backups", username: "lab", password: "pw", maxProtocol: "SMB3" } as never, "");

        expect(files.map((file) => file.path)).toEqual([
            "Long_hidden_backup_name_2026-10-10_full.tar",
            "system.tar",
            "Long_folder_name_over_thirty_chars_x/inner.tar",
        ]);
        expect(commands.some((command) => command.startsWith("dir"))).toBe(true);
    });
});
