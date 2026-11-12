import type { FileInfo } from "@/lib/core/interfaces";

/** What a cached row of a listing says of its file, `lastModified` as a date or as the text JSON made of it. */
export interface CachedFileState {
    path: string;
    size: number;
    lastModified: Date | string;
}

/** The time of a date or of the text JSON made of one, NaN when it is no time. */
function timeOf(value: Date | string): number {
    return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/**
 * Whether the storage holds another file under the path of a cached row: one a later run wrote
 * under the same name, which a naming template without a time does on every run. A size or a
 * time of the storage that differs tells it. A time either side cannot read decides nothing.
 */
export function isRewritten(remote: Pick<FileInfo, "size" | "lastModified">, cached: CachedFileState): boolean {
    if (remote.size !== cached.size) {
        return true;
    }
    const before = timeOf(cached.lastModified);
    const now = timeOf(remote.lastModified);
    return Number.isFinite(before) && Number.isFinite(now) && before !== now;
}

/**
 * What a reconciliation changes in a cached listing: the paths the storage no longer holds, and
 * the backups whose sidecar it reads again, those it has not listed before and those written
 * again under a path it has.
 */
export function listingChanges(
    cachedFiles: readonly CachedFileState[],
    remoteBackups: readonly FileInfo[],
): { removedPaths: Set<string>; freshFiles: FileInfo[] } {
    const cachedByPath = new Map(cachedFiles.map((file) => [file.path, file]));
    const remotePaths = new Set(remoteBackups.map((file) => file.path));
    const removedPaths = new Set([...cachedByPath.keys()].filter((path) => !remotePaths.has(path)));
    const freshFiles = remoteBackups.filter((file) => {
        const cached = cachedByPath.get(file.path);
        return cached === undefined || isRewritten(file, cached);
    });
    return { removedPaths, freshFiles };
}
