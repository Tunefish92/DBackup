/**
 * Lint Guard: the Docker image starts as a user other than root and without internet.
 *
 * OpenShift starts every container as an arbitrary UID in group 0, never as root. The entrypoint
 * then cannot use gosu or chown, so it runs the start as that user, and the image lets group 0
 * write what the app writes. An entrypoint that only knows the root path, or a folder that only
 * the UID 1001 can write, stops the container on OpenShift before the app ever starts.
 *
 * On a cluster without internet, the tools of the image that call home wait for their timeout,
 * SqlPackage for minutes. The image switches them off.
 *
 * Run with: pnpm test tests/unit/lint-guards/docker-image-openshift.test.ts
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf-8");
const entrypoint = fs.readFileSync(path.join(ROOT, "docker-entrypoint.sh"), "utf-8");

/** The Dockerfile with its continued lines joined, one instruction per line. */
const instructions = dockerfile.replace(/\\\n/g, " ").split("\n");

/** The instructions of the runner stage, the image that ships. */
const runner = instructions.slice(instructions.findIndex((line) => /^FROM\s+\S+\s+AS\s+runner\b/.test(line)));

/** The commands of the entrypoint for a container started as a user other than root, without comments. */
const nonRootStart = entrypoint.indexOf('if [ "$(id -u)" != "0" ]; then');
const nonRoot = entrypoint
    .slice(nonRootStart, entrypoint.indexOf("\nfi\n", nonRootStart))
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

describe("lint guard: the Docker image on OpenShift and without internet", () => {
    it("starts a container that is not root without gosu, before the first gosu", () => {
        expect(nonRootStart).toBeGreaterThan(0);
        expect(nonRootStart).toBeLessThan(entrypoint.indexOf('gosu "$PUID'));
        expect(nonRoot).not.toContain("gosu");
        expect(nonRoot).not.toContain("chown");
        expect(nonRoot).toMatch(/^\s*prisma migrate deploy$/m);
        expect(nonRoot).toMatch(/^\s*exec node custom-server\.js$/m);
    });

    it("runs the same steps at the start for root and for any other user", () => {
        const steps = (text: string) =>
            [...text.matchAll(/^\s*(?:exec\s+)?(?:gosu "\$PUID:\$PGID"\s+)?((?:node|prisma)\s.+)$/gm)].map((m) => m[1].trim());
        const rootPath = entrypoint.slice(entrypoint.indexOf("\nfi\n", nonRootStart));
        expect(steps(nonRoot)).toEqual(steps(rootPath));
        expect(steps(nonRoot).length).toBeGreaterThan(0);
    });

    it("adds the UID to /etc/passwd, which group 0 may write", () => {
        expect(nonRoot).toContain(">> /etc/passwd");
        const setup = runner.find((line) => line.startsWith("RUN") && line.includes("mkdir -p /data/db"));
        expect(setup).toBeDefined();
        expect(setup).toContain("chmod g=u /etc/passwd");
    });

    it("lets group 0 write /data and the cache of Next.js", () => {
        const setup = runner.find((line) => line.startsWith("RUN") && line.includes("mkdir -p /data/db"))!;
        expect(setup).toMatch(/chown -R 1001:0 \/data \/app\/\.next\/cache/);
        expect(setup).toMatch(/chmod -R g=u \/data \/app\/\.next\/cache/);
    });

    it("sets no USER, so Docker still starts as root and drops to PUID:PGID", () => {
        expect(instructions.filter((line) => /^USER\s/.test(line))).toEqual([]);
    });

    it.each(["CHECKPOINT_DISABLE=1", "DACFX_TELEMETRY_OPTOUT=1", "NEXT_TELEMETRY_DISABLED=1"])("sets %s in the image", (env) => {
        expect(runner.filter((line) => line.trim() === `ENV ${env}`)).toHaveLength(1);
    });
});
