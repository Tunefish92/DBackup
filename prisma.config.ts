import path from "node:path";
import type { PrismaConfig } from "prisma";

/**
 * The configuration of the Prisma CLI: where the schema lives, and the database `prisma migrate`
 * works on. The migrations are the folder beside the schema, also for a `--schema` of another
 * version, which the tests of upgrades use. The image runs the CLI at every start without the code
 * of the project, so this file imports nothing but types.
 */

/**
 * The database of DATABASE_URL. `pnpm dev` keeps it in .env, which the CLI does not read since
 * Prisma 7, so a missing variable is read from there.
 */
function databaseUrl(): string {
    if (!process.env.DATABASE_URL) {
        try {
            process.loadEnvFile(path.join(process.cwd(), ".env"));
        } catch {
            // No .env, the default below applies.
        }
    }
    return process.env.DATABASE_URL ?? "file:./dev.db";
}

/**
 * A relative SQLite file against the folder of schema.prisma, where Prisma 6 found it and where
 * `src/lib/database-url.ts` finds it for the app.
 */
function fromSchemaFolder(url: string): string {
    if (!url.startsWith("file:")) {
        return url;
    }
    const [file, query] = url.slice("file:".length).split("?");
    const absolute = path.isAbsolute(file) ? file : path.resolve(process.cwd(), "prisma", file);
    return `file:${absolute}${query ? `?${query}` : ""}`;
}

export default {
    schema: "prisma/schema.prisma",
    datasource: { url: fromSchemaFolder(databaseUrl()) },
} satisfies PrismaConfig;
