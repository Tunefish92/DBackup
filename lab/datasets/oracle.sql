-- Dataset of the dev lab for Oracle 21 XE and 23ai Free, run by sqlplus as SYSTEM in the
-- pluggable database LABPDB. Loaded once by `pnpm lab:up` when the view SHOP.ORDER_TOTALS, made
-- last, is missing. It starts over from nothing, so a load that broke off can simply run again.
-- The folder of the directory object is made by the load command before sqlplus starts.

WHENEVER SQLERROR EXIT FAILURE
SET DEFINE OFF
SET FEEDBACK OFF

BEGIN
    FOR existing IN (SELECT username FROM all_users WHERE username IN ('SHOP', 'INVENTORY')) LOOP
        EXECUTE IMMEDIATE 'DROP USER ' || existing.username || ' CASCADE';
    END LOOP;
END;
/

CREATE OR REPLACE DIRECTORY dbackup_dir AS '/opt/oracle/oradata/dbackup';

CREATE USER shop IDENTIFIED BY "ShopPassword1";
GRANT CREATE SESSION, CREATE TABLE, CREATE VIEW, CREATE SEQUENCE, CREATE PROCEDURE, UNLIMITED TABLESPACE TO shop;

ALTER SESSION SET CURRENT_SCHEMA = shop;

CREATE TABLE customers (
    id NUMBER(10) PRIMARY KEY,
    name NVARCHAR2(100) NOT NULL,
    email VARCHAR2(200) NOT NULL UNIQUE,
    note NCLOB,
    created_at TIMESTAMP NOT NULL
);

CREATE TABLE orders (
    id NUMBER(10) PRIMARY KEY,
    customer_id NUMBER(10) NOT NULL REFERENCES customers (id),
    amount NUMBER(12, 2) NOT NULL,
    paid NUMBER(1) DEFAULT 0 NOT NULL,
    receipt BLOB,
    ordered_on DATE NOT NULL
);

CREATE SEQUENCE invoice_number START WITH 1000;

INSERT INTO customers VALUES (1, N'Zoë Müller', 'zoe@example.ch', N'Grüezi 🦊', TIMESTAMP '2024-02-29 23:59:59');
INSERT INTO customers VALUES (2, N'李雷', 'lilei@example.cn', NULL, TIMESTAMP '1999-12-31 00:00:00');
INSERT INTO customers VALUES (3, N'O''Brien & Söhne', 'obrien@example.ie', N'Quote '' and backslash \ inside', TIMESTAMP '2026-01-01 12:00:00');

INSERT INTO orders VALUES (1, 1, 1234567890.12, 1, HEXTORAW('DEADBEEF00FF'), DATE '2024-02-29');
INSERT INTO orders VALUES (2, 1, 0.01, 0, NULL, DATE '1970-01-01');
INSERT INTO orders VALUES (3, 2, 99.95, 1, HEXTORAW('00'), DATE '2038-01-19');
COMMIT;

CREATE OR REPLACE PROCEDURE mark_paid (p_order_id IN NUMBER) AS
BEGIN
    UPDATE orders SET paid = 1 WHERE id = p_order_id;
END;
/

CREATE USER inventory IDENTIFIED BY "InventoryPassword1";
GRANT CREATE SESSION, UNLIMITED TABLESPACE TO inventory;
CREATE TABLE inventory.items (sku VARCHAR2(20) PRIMARY KEY, quantity NUMBER NOT NULL);
INSERT INTO inventory.items VALUES ('A-1', 5);
COMMIT;

CREATE VIEW order_totals AS
    SELECT c.name, SUM(o.amount) AS total FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.name;

EXIT
