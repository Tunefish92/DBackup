import fs from "fs/promises";
import oracledb from "oracledb";

import type { OracleConnection } from "./connection";
import { probeFileName } from "./identifiers";

/**
 * Moving files in and out of an Oracle directory object over the SQL*Net connection.
 *
 * Data Pump only reads and writes files on the server. Reading one back goes through a BFILE,
 * writing one through UTL_FILE, so a backup needs neither a shared folder nor SSH access to
 * the database machine, which also makes it work against managed services such as Amazon RDS.
 *
 * Every bind is named with a `p_` prefix. Names like :file, :mode or :size are reserved words
 * in Oracle and fail with ORA-01745.
 */

/** Bytes per round trip when reading a file. A BFILE read of this size is a single LOB call. */
export const DOWNLOAD_CHUNK_BYTES = 4 * 1024 * 1024;

/** Bytes per round trip when writing a file, bound as one temporary BLOB. */
export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;

/** The largest RAW a PL/SQL variable holds, and so the piece size of UTL_FILE.PUT_RAW. */
const RAW_PIECE_BYTES = 32767;

const SIZE_QUERY = `SELECT DBMS_LOB.GETLENGTH(BFILENAME(:p_dir, :p_file)) AS file_length FROM dual`;

const BFILE_QUERY = `SELECT BFILENAME(:p_dir, :p_file) FROM dual`;

/**
 * Reads up to 32767 bytes of a file. The fallback for a driver that cannot read a BFILE itself,
 * slower because every piece is a round trip of its own.
 */
const READ_PIECE_BLOCK = `
DECLARE
    l_file   BFILE := BFILENAME(:p_dir, :p_file);
    l_amount INTEGER := :p_amount;
    l_data   RAW(32767);
BEGIN
    DBMS_LOB.FILEOPEN(l_file, DBMS_LOB.FILE_READONLY);
    BEGIN
        DBMS_LOB.READ(l_file, l_amount, :p_offset, l_data);
    EXCEPTION
        WHEN NO_DATA_FOUND THEN
            l_data := NULL;
    END;
    DBMS_LOB.FILECLOSE(l_file);
    :p_data := l_data;
EXCEPTION
    WHEN OTHERS THEN
        IF DBMS_LOB.FILEISOPEN(l_file) = 1 THEN
            DBMS_LOB.FILECLOSE(l_file);
        END IF;
        RAISE;
END;`;

/**
 * Writes one chunk into a file, creating it with mode wb or adding to it with ab. UTL_FILE
 * writes at most 32767 bytes at once, so the chunk is written in pieces of that size.
 */
const WRITE_CHUNK_BLOCK = `
DECLARE
    l_chunk    BLOB := :p_chunk;
    l_file     UTL_FILE.FILE_TYPE;
    l_length   INTEGER := NVL(DBMS_LOB.GETLENGTH(l_chunk), 0);
    l_position INTEGER := 1;
    l_amount   INTEGER;
    l_buffer   RAW(32767);
BEGIN
    l_file := UTL_FILE.FOPEN(:p_dir, :p_file, :p_open_mode, 32767);
    WHILE l_position <= l_length LOOP
        l_amount := LEAST(32767, l_length - l_position + 1);
        DBMS_LOB.READ(l_chunk, l_amount, l_position, l_buffer);
        UTL_FILE.PUT_RAW(l_file, l_buffer, TRUE);
        l_position := l_position + l_amount;
    END LOOP;
    UTL_FILE.FCLOSE(l_file);
EXCEPTION
    WHEN OTHERS THEN
        IF UTL_FILE.IS_OPEN(l_file) THEN
            UTL_FILE.FCLOSE(l_file);
        END IF;
        RAISE;
END;`;

const REMOVE_BLOCK = `BEGIN UTL_FILE.FREMOVE(:p_dir, :p_file); END;`;

interface RangeReader {
    read(offset: number, amount: number): Promise<Buffer>;
    close(): Promise<void>;
}

/** The size of a file in the directory. Fails when it is missing or the directory cannot be read. */
export async function remoteFileSize(connection: OracleConnection, directory: string, file: string): Promise<number> {
    const result = await connection.execute<[number]>(SIZE_QUERY, { p_dir: directory, p_file: file }, { outFormat: oracledb.OUT_FORMAT_ARRAY });
    const length = result.rows?.[0]?.[0];
    if (length === null || length === undefined) {
        throw new Error(`Oracle reports no length for ${directory}/${file}`);
    }
    return Number(length);
}

/** Reads through the driver's own BFILE support, one LOB call per chunk. */
async function bfileReader(connection: OracleConnection, directory: string, file: string): Promise<RangeReader> {
    const result = await connection.execute<[oracledb.Lob]>(BFILE_QUERY, { p_dir: directory, p_file: file }, { outFormat: oracledb.OUT_FORMAT_ARRAY });
    const lob = result.rows?.[0]?.[0];
    if (!lob) throw new Error(`Oracle returned no BFILE for ${directory}/${file}`);
    return {
        read: async (offset, amount) => {
            const data = await lob.getData(offset, amount);
            if (data === null || data === undefined) return Buffer.alloc(0);
            return Buffer.isBuffer(data) ? data : Buffer.from(data);
        },
        close: async () => {
            lob.destroy();
        },
    };
}

/** Reads through PL/SQL in pieces of 32767 bytes. */
function plsqlReader(connection: OracleConnection, directory: string, file: string): RangeReader {
    return {
        read: async (offset, amount) => {
            const pieces: Buffer[] = [];
            let read = 0;
            while (read < amount) {
                const want = Math.min(RAW_PIECE_BYTES, amount - read);
                const result = await connection.execute<{ p_data: Buffer | null }>(READ_PIECE_BLOCK, {
                    p_dir: directory,
                    p_file: file,
                    p_amount: want,
                    p_offset: offset + read,
                    p_data: { dir: oracledb.BIND_OUT, type: oracledb.BUFFER, maxSize: RAW_PIECE_BYTES },
                });
                const piece = result.outBinds?.p_data;
                if (!piece || piece.length === 0) break;
                pieces.push(piece);
                read += piece.length;
            }
            return Buffer.concat(pieces);
        },
        close: async () => {},
    };
}

/**
 * A driver error (NJS-...) on the first BFILE read means this driver cannot read one, and the
 * PL/SQL path takes over. An Oracle error (ORA-...) would hit that path just the same, so it is
 * passed on as it is.
 */
function isDriverLimitation(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /^NJS-\d+/.test(message);
}

/**
 * Copies a file of the directory into a local file. `onProgress` receives the bytes copied so far.
 */
export async function downloadFile(
    connection: OracleConnection,
    directory: string,
    file: string,
    localPath: string,
    onProgress?: (bytes: number, total: number) => void,
): Promise<number> {
    const total = await remoteFileSize(connection, directory, file);
    const handle = await fs.open(localPath, "w");
    let reader: RangeReader | null = null;
    try {
        let offset = 1;
        while (offset <= total) {
            const amount = Math.min(DOWNLOAD_CHUNK_BYTES, total - offset + 1);
            let data: Buffer;
            if (!reader) {
                reader = await bfileReader(connection, directory, file);
                try {
                    data = await reader.read(offset, amount);
                } catch (error: unknown) {
                    if (!isDriverLimitation(error)) throw error;
                    await reader.close().catch(() => {});
                    reader = plsqlReader(connection, directory, file);
                    data = await reader.read(offset, amount);
                }
            } else {
                data = await reader.read(offset, amount);
            }
            if (data.length === 0) {
                throw new Error(`${file} ended after ${offset - 1} of ${total} bytes`);
            }
            await handle.write(data);
            offset += data.length;
            onProgress?.(offset - 1, total);
        }
    } finally {
        if (reader) await reader.close().catch(() => {});
        await handle.close();
    }
    return total;
}

/** The end of a text file of the directory, at most `maxBytes`, for the Data Pump log. */
export async function readTextTail(connection: OracleConnection, directory: string, file: string, maxBytes = 1024 * 1024): Promise<string> {
    const total = await remoteFileSize(connection, directory, file);
    if (total === 0) return "";
    const start = Math.max(1, total - maxBytes + 1);
    let reader = await bfileReader(connection, directory, file);
    try {
        let data: Buffer;
        try {
            data = await reader.read(start, total - start + 1);
        } catch (error: unknown) {
            if (!isDriverLimitation(error)) throw error;
            await reader.close().catch(() => {});
            reader = plsqlReader(connection, directory, file);
            data = await reader.read(start, total - start + 1);
        }
        return data.toString("utf8");
    } finally {
        await reader.close().catch(() => {});
    }
}

/** Writes one chunk. The first creates the file, the others add to it. */
async function writeChunk(connection: OracleConnection, directory: string, file: string, chunk: Buffer, first: boolean): Promise<void> {
    await connection.execute(WRITE_CHUNK_BLOCK, {
        p_chunk: { val: chunk, type: oracledb.BLOB, dir: oracledb.BIND_IN },
        p_dir: directory,
        p_file: file,
        p_open_mode: first ? "wb" : "ab",
    });
}

/**
 * Copies a local file into the directory. `onProgress` receives the bytes copied so far.
 */
export async function uploadFile(
    connection: OracleConnection,
    localPath: string,
    directory: string,
    file: string,
    onProgress?: (bytes: number, total: number) => void,
): Promise<number> {
    const { size: total } = await fs.stat(localPath);
    const handle = await fs.open(localPath, "r");
    try {
        const buffer = Buffer.alloc(UPLOAD_CHUNK_BYTES);
        let written = 0;
        let first = true;
        while (first || written < total) {
            const { bytesRead } = await handle.read(buffer, 0, UPLOAD_CHUNK_BYTES, written);
            if (bytesRead === 0 && !first) {
                throw new Error(`${localPath} ended after ${written} of ${total} bytes`);
            }
            await writeChunk(connection, directory, file, buffer.subarray(0, bytesRead), first);
            written += bytesRead;
            first = false;
            onProgress?.(written, total);
        }
        return written;
    } finally {
        await handle.close();
    }
}

/** Removes a file of the directory. Missing files and failures are ignored, this is cleanup. */
export async function removeRemoteFile(connection: OracleConnection, directory: string, file: string): Promise<void> {
    await connection.execute(REMOVE_BLOCK, { p_dir: directory, p_file: file }).catch(() => {});
}

const PROBE_CONTENT = Buffer.from("DBackup directory check\n", "utf8");

/** The first line of an Oracle error, which names the problem without its backtrace. */
function firstLine(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.split("\n")[0].trim();
}

/**
 * Writes a small file into the directory, reads its length back and removes it. Returns what
 * went wrong, or null when the directory works both ways.
 */
export async function probeDirectory(connection: OracleConnection, directory: string): Promise<string | null> {
    const file = probeFileName();
    try {
        await writeChunk(connection, directory, file, PROBE_CONTENT, true);
    } catch (error: unknown) {
        return `writing failed (${firstLine(error)})`;
    }
    try {
        const size = await remoteFileSize(connection, directory, file);
        if (size !== PROBE_CONTENT.length) {
            return `a test file came back with ${size} instead of ${PROBE_CONTENT.length} bytes`;
        }
        return null;
    } catch (error: unknown) {
        return `reading failed (${firstLine(error)})`;
    } finally {
        await removeRemoteFile(connection, directory, file);
    }
}
