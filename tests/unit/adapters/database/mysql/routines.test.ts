import { describe, it, expect } from "vitest";
import { Readable } from "stream";
import { insertAfterUse, needsOwnRoutines, parseXmlRows, readRoutines, routinesSql, type RoutineDefinition } from "@/lib/adapters/database/mysql/routines";

/** The XML the mysql client prints for SHOW CREATE PROCEDURE, as MySQL 26 answered it. */
const SHOW_PROCEDURE = `<?xml version="1.0"?>
<resultset statement="SHOW CREATE PROCEDURE \`p\`" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <row>
\t<field name="Procedure">p</field>
\t<field name="sql_mode">ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES</field>
\t<field name="Create Procedure">CREATE DEFINER=\`root\`@\`localhost\` PROCEDURE \`p\`(IN a INT)
    COMMENT 'it''s &lt;a&gt; &amp; &quot;b&quot;'
BEGIN
  SELECT CONCAT('x', '\\n', a);
END</field>
\t<field name="character_set_client">utf8mb4</field>
\t<field name="collation_connection">utf8mb4_0900_ai_ci</field>
\t<field name="Database Collation">utf8mb4_0900_ai_ci</field>
  </row>
</resultset>
`;

const SHOW_FUNCTION = `<?xml version="1.0"?>
<resultset statement="SHOW CREATE FUNCTION \`f\`" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <row>
\t<field name="Function">f</field>
\t<field name="sql_mode"></field>
\t<field name="Create Function">CREATE DEFINER=\`root\`@\`%\` FUNCTION \`f\`(x INT) RETURNS int
    DETERMINISTIC
RETURN x+1</field>
\t<field name="character_set_client">latin1</field>
\t<field name="collation_connection">latin1_swedish_ci</field>
\t<field name="Database Collation">utf8mb4_0900_ai_ci</field>
  </row>
</resultset>
`;

const LIST = `<?xml version="1.0"?>
<resultset statement="SELECT ..." xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <row>
\t<field name="ROUTINE_TYPE">FUNCTION</field>
\t<field name="ROUTINE_NAME">f</field>
  </row>
  <row>
\t<field name="ROUTINE_TYPE">PROCEDURE</field>
\t<field name="ROUTINE_NAME">p</field>
  </row>
</resultset>
`;

/** Reads a stream to its end as text. */
async function collect(stream: NodeJS.ReadableStream): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk as Buffer));
    }
    return Buffer.concat(chunks).toString("utf8");
}

describe("which servers get their routines from DBackup", () => {
    it("takes over on MySQL 26 and later, which the MariaDB dump tool asks for packages", () => {
        expect(needsOwnRoutines({ type: "mysql", detectedVersion: "26.10.0" })).toBe(true);
        expect(needsOwnRoutines({ detectedVersion: "10.3.0" })).toBe(true);
    });

    it("leaves MySQL 9 and older, MariaDB and an unknown version to the dump tool", () => {
        expect(needsOwnRoutines({ type: "mysql", detectedVersion: "9.7.4" })).toBe(false);
        expect(needsOwnRoutines({ type: "mysql", detectedVersion: "8.0.46" })).toBe(false);
        expect(needsOwnRoutines({ type: "mariadb", detectedVersion: "11.8.3" })).toBe(false);
        expect(needsOwnRoutines({ type: "mysql", detectedVersion: "11.4.2-MariaDB" })).toBe(false);
        expect(needsOwnRoutines({ type: "mysql" })).toBe(false);
    });
});

describe("the XML of the mysql client", () => {
    it("reads every field of every row with its entities undone, and NULL as null", () => {
        const rows = parseXmlRows(`${LIST}<resultset><row><field name="a" xsi:nil="true" /><field name="b"></field></row></resultset>`);

        expect(rows).toEqual([
            { ROUTINE_TYPE: "FUNCTION", ROUTINE_NAME: "f" },
            { ROUTINE_TYPE: "PROCEDURE", ROUTINE_NAME: "p" },
            { a: null, b: "" },
        ]);
        expect(parseXmlRows(SHOW_PROCEDURE)[0]["Create Procedure"]).toContain(`COMMENT 'it''s <a> & "b"'`);
    });
});

describe("reading the routines", () => {
    it("lists them and reads all of them in one more call, functions first", async () => {
        const asked: string[] = [];
        const routines = await readRoutines(async (sql) => {
            asked.push(sql);
            return { code: 0, stderr: "", stdout: sql.includes("information_schema") ? LIST : SHOW_FUNCTION + SHOW_PROCEDURE };
        }, "shop");

        expect(asked[1]).toBe("SHOW CREATE FUNCTION `f`; SHOW CREATE PROCEDURE `p`");
        expect(routines.map((routine) => [routine.type, routine.name, routine.characterSetClient])).toEqual([
            ["FUNCTION", "f", "latin1"],
            ["PROCEDURE", "p", "utf8mb4"],
        ]);
        expect(routines[1].create).toContain("SELECT CONCAT('x', '\\n', a);");
    });

    it("asks nothing more for a database without routines", async () => {
        const asked: string[] = [];
        const routines = await readRoutines(async (sql) => {
            asked.push(sql);
            return { code: 0, stderr: "", stdout: "<resultset></resultset>" };
        }, "shop");

        expect(routines).toEqual([]);
        expect(asked).toHaveLength(1);
    });

    it("fails the dump with the error of the client instead of leaving the routines out", async () => {
        await expect(readRoutines(async () => ({ code: 1, stdout: "", stderr: "ERROR 1142 (42000): SELECT command denied" }), "shop"))
            .rejects.toThrow("Reading the stored procedures and functions of shop failed: ERROR 1142 (42000): SELECT command denied");
    });

    it("quotes a name with a backtick", async () => {
        const asked: string[] = [];
        const list = LIST.replace(">f<", ">we`ird<");
        await readRoutines(async (sql) => {
            asked.push(sql);
            return { code: 0, stderr: "", stdout: sql.includes("information_schema") ? list : SHOW_FUNCTION + SHOW_PROCEDURE };
        }, "shop");

        expect(asked[1]).toContain("SHOW CREATE FUNCTION `we``ird`");
    });
});

describe("the routines in the dump", () => {
    const routine: RoutineDefinition = {
        type: "PROCEDURE",
        name: "p",
        sqlMode: "ANSI_QUOTES",
        create: "CREATE DEFINER=`root`@`%` PROCEDURE `p`()\nBEGIN\n  SELECT 1;\nEND",
        characterSetClient: "latin1",
        collationConnection: "latin1_swedish_ci",
    };

    it("writes each in the shape of mysqldump, between its own delimiters and settings", () => {
        const sql = routinesSql("shop", [routine]);

        expect(sql).toContain("-- Dumping routines for database 'shop'");
        expect(sql).toContain("/*!50003 DROP PROCEDURE IF EXISTS `p` */;");
        expect(sql).toContain("/*!50003 SET character_set_client  = latin1 */ ;");
        expect(sql).toContain("/*!50003 SET sql_mode              = 'ANSI_QUOTES' */ ;");
        expect(sql).toContain(`DELIMITER ;;\n${routine.create}\n;;\nDELIMITER ;`);
        expect(routinesSql("shop", [])).toBe("");
    });

    it("goes right after the USE of the database, before the views at the end", async () => {
        const dump = "-- head\nCREATE DATABASE `shop`;\nUSE `shop`;\nCREATE TABLE t (id INT);\nUSE `shop`;\nCREATE VIEW v AS SELECT f(1);\n";
        // One byte at a time, so the USE line is split over chunks.
        const out = await collect(Readable.from([...Buffer.from(dump)].map((byte) => Buffer.from([byte]))).pipe(insertAfterUse("-- routines\n")));

        expect(out).toBe("-- head\nCREATE DATABASE `shop`;\nUSE `shop`;\n-- routines\nCREATE TABLE t (id INT);\nUSE `shop`;\nCREATE VIEW v AS SELECT f(1);\n");
    });

    it("goes to the end of a dump without a USE", async () => {
        const out = await collect(Readable.from([Buffer.from("CREATE TABLE t (id INT);\n")]).pipe(insertAfterUse("-- routines\n")));

        expect(out).toBe("CREATE TABLE t (id INT);\n-- routines\n");
    });
});
