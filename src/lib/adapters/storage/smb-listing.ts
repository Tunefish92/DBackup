/**
 * The output of smbclient, read without the patterns of samba-client, which miss rows.
 *
 * smbclient prints each entry of `dir` as `%-30s%7.7s %8.0f  %s`: two spaces, the name padded to
 * 30 characters, the attributes right-aligned in 7, a space, the size right-aligned in 8, two
 * spaces and the time. samba-client wants at least six spaces and one or two capital letters
 * before the size, so it drops a row whose name has 30 characters or more next to two flags, one
 * with three flags like `AHS`, and one with a lower-case flag like `An` of a Windows server with
 * indexing turned off, where a whole share lists as empty. A folder dropped hides everything
 * below it. This reads each row from its end instead, where every field has its width.
 */

/** An entry of a folder as the listing of the adapter reads it. */
export interface SmbDirEntry {
    name: string;
    /** The attributes smbclient prints, like `D`, `A`, `AHS` or `An`. `D` is a folder. */
    type: string;
    size: number;
    modifyTime: Date;
}

/** The time at the end of a row, as smbclient prints it: `Sat Oct 10 03:56:09 2026`, a day below 10 with a space. */
const ROW = /^ {2}(.*) ([0-9]+) {2}([A-Z][a-z]{2} [A-Z][a-z]{2} [ 0-9][0-9] [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4})$/;

/** The width smbclient pads a name to, and the one of the attributes. */
const NAME_WIDTH = 30;
const ATTRIBUTE_WIDTH = 7;
/** The size takes at least 8 characters, wider for a larger number. */
const SIZE_WIDTH = 8;

/** Reads one row of `dir`, null for a line that is no entry, like the line of the free blocks. */
export function parseSmbDirRow(line: string): SmbDirEntry | null {
    const match = ROW.exec(line.replace(/\r$/, ""));
    if (!match) {
        return null;
    }
    const [, head, digits, time] = match;
    // What stands before the size: the name, the attributes and the padding of the size.
    const padding = Math.max(0, SIZE_WIDTH - digits.length);
    if (head.length < ATTRIBUTE_WIDTH + padding || !/^ *$/.test(head.slice(head.length - padding))) {
        return null;
    }
    const attributes = head.slice(head.length - padding - ATTRIBUTE_WIDTH, head.length - padding);
    if (!/^ *[A-Za-z]*$/.test(attributes)) {
        return null;
    }
    const field = head.slice(0, head.length - padding - ATTRIBUTE_WIDTH);
    // A name shorter than its column is padded with spaces, a longer one stands as it is.
    const name = field.length <= NAME_WIDTH ? field.replace(/ +$/, "") : field;
    if (name === "") {
        return null;
    }
    return {
        name,
        type: attributes.trim(),
        size: Number(digits),
        // samba-client reads the time as UTC, which the dates of the listings kept so far rely on.
        modifyTime: new Date(`${time}Z`),
    };
}

/** Every entry of the output of `dir`, in the order smbclient printed them. */
export function parseSmbDir(output: string): SmbDirEntry[] {
    const entries: SmbDirEntry[] = [];
    for (const line of output.split("\n")) {
        const entry = parseSmbDirRow(line);
        if (entry) {
            entries.push(entry);
        }
    }
    return entries;
}

/** The status codes of an answer of smbclient, like `NT_STATUS_ACCESS_DENIED`. */
export function ntStatuses(output: string): string[] {
    return output.match(/\bNT_STATUS_[A-Z0-9_]+\b/g) ?? [];
}
