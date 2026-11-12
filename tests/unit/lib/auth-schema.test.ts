// @vitest-environment node
import { describe, expect, it } from "vitest";

/**
 * better-auth checks the tables of DBackup against what it and its plugins write before every
 * request, and refuses every sign-in on a mismatch. The check reads the data model of the generated
 * Prisma client, so it runs here against the real client and the real configuration of `auth`,
 * without a database.
 */
describe("the tables of better-auth", () => {
    it("hold what better-auth and its plugins write", async () => {
        const { auth } = await import("@/lib/auth");
        const context = await auth.$context;

        // The check that guards every request. Without it the test proves nothing, so a client that
        // stops carrying its data model fails here too.
        expect(context.checkSchema).toBeTypeOf("function");
        await expect(context.checkSchema?.()).resolves.toBeUndefined();
    });
});
