# Oracle Database

Backs up and restores Oracle schemas with Data Pump, without any Oracle client installed.

## Supported Versions

| Versions | Editions |
| :--- | :--- |
| 12.1 and later, including 19c, 21c and 23ai | Enterprise, Standard Edition 2, Express (XE), Free |

::: info Older versions
DBackup talks to Oracle through the Thin mode of node-oracledb, which needs Oracle Database 12.1 or later. 11.2 and older are not supported.
:::

Each **schema** is one database in DBackup. A job lists every schema Oracle did not create itself, and you pick the ones to back up like databases of any other source.

## Prerequisites

The login needs to run Data Pump and to read and write one directory object on the server.

- **Data Pump roles**: `DATAPUMP_EXP_FULL_DATABASE` to back up schemas other than its own, `DATAPUMP_IMP_FULL_DATABASE` to restore into them. `SYSTEM` has both.
- **A directory object** with `READ` and `WRITE` for the login. `DATA_PUMP_DIR` exists in every database and pluggable database. It needs room for the dump of the largest schema, which stays there only while DBackup copies it.
- **`CREATE TABLE` and quota** in the default tablespace of the login. Data Pump keeps the state of every job in a table of the user who runs it.
- **`EXECUTE` on `UTL_FILE`**, which Oracle grants to `PUBLIC` unless a hardening guide revoked it.

<details>
<summary>A dedicated backup user</summary>

Run as `SYS` in the pluggable database that holds the schemas:

```sql
CREATE USER dbackup IDENTIFIED BY "a-strong-password";
GRANT CREATE SESSION, CREATE TABLE TO dbackup;
ALTER USER dbackup QUOTA 100M ON users;
GRANT DATAPUMP_EXP_FULL_DATABASE, DATAPUMP_IMP_FULL_DATABASE TO dbackup;
GRANT READ, WRITE ON DIRECTORY data_pump_dir TO dbackup;
GRANT EXECUTE ON sys.utl_file TO dbackup;
```

Leave out `DATAPUMP_IMP_FULL_DATABASE` for a user that only backs up.

</details>

## Configuration

| Field | Description | Default | Required |
| :--- | :--- | :--- | :--- |
| **How DBackup connects** | **Direct** to the listener, or **Over SSH** through a server DBackup logs into | `Direct` | ✅ |
| **Host** | Oracle server hostname or IP. Over SSH, as seen from the SSH server | `localhost` | ✅ |
| **Port** | Listener port | `1521` | ✅ |
| **Service name** | Service of the database or pluggable database, like `FREEPDB1` or `ORCLPDB1` | - | ✅ |
| **Login** | `USERNAME_PASSWORD` [credential profile](/user-guide/security/credential-profiles) | - | ✅ |
| **Directory object** | Directory Data Pump writes its dump and log files to | `DATA_PUMP_DIR` | ❌ |
| **Consistent export** | Exports all tables of a schema as of the moment the export starts | On | ❌ |
| **TLS** | Connects with TCPS instead of TCP | Off | ❌ |
| **SSH host**, **Port**, **SSH login** | The SSH server, over SSH only | `22` | Over SSH |

::: tip Pluggable databases
Connect to the service of the pluggable database that holds your schemas, not to the root container. The schemas of the root, like `C##` users, are not backed up.
:::

## Setup Guide

1. Create the backup user or pick an existing login, see [Prerequisites](#prerequisites).
2. Create a `USERNAME_PASSWORD` credential profile for it.
3. Go to **Connections** → **Databases** → **New database** and pick **Oracle Database**.
4. Choose **Direct**, or **Over SSH** when the listener is only reachable from another server.
5. Enter host, port and **Service name**, and pick the **Login**.
6. Change **Directory object** under **Options** if your login cannot use `DATA_PUMP_DIR`.
7. Click **Test connection**. It logs in, writes a small file into the directory, checks its size and removes it.
8. Create a job and pick the schemas to back up.

## How It Works

**Backup.** For every schema DBackup starts a Data Pump export inside the server through `DBMS_DATAPUMP`, the API behind `expdp`. The dump lands in the directory object, DBackup reads it over the same SQL*Net connection into the backup archive and deletes it and its log from the server. Warnings from Data Pump appear in the log of the run. A table whose rows could not be exported fails the backup.

**Restore.** DBackup writes the dump into the directory object over the connection and runs a Data Pump import. Restoring under a new schema name remaps the schema and creates its user, as long as the backup was taken by a login with `DATAPUMP_EXP_FULL_DATABASE`. A new name typed in lower case becomes upper case, the way Oracle stores an unquoted name.

::: warning Restoring into an existing schema
Tables that exist are replaced by the ones of the backup. Other objects that already exist, like sequences, views or procedures, are kept as they are and listed in the log of the restore. DBackup recompiles the schema afterwards, so views and procedures of the replaced tables are valid again, and names any object that still is not. Tables the backup does not hold are left alone. For an exact copy, restore under a new name or drop the schema first. Schemas Oracle created itself, like `SYSTEM`, are refused as a target.
:::

**Over SSH** DBackup tunnels the SQL*Net connection through the SSH server, like it does for [MSSQL](/user-guide/sources/mssql). Nothing has to be installed there, but the SSH server has to allow TCP forwarding.

Every schema is its own entry of the [backup archive](/user-guide/features/backups) as a `.dmp` file, compressed and encrypted by DBackup. Data Pump's own compression is not used, since it needs the Advanced Compression option.

The tablespaces of a schema have to exist on the server you restore to. A backup of a newer Oracle version is not restored onto an older server.

::: info Tenants
A tenant that [blocks the local network](/user-guide/admin/tenants#network) cannot use Oracle connections, since the driver follows redirects of the listener that DBackup cannot check. A schema of a [shared server](/user-guide/admin/shared-databases) goes to a customer like any other database, but only the provider restores it.
:::

## Troubleshooting

### The directory is not usable

```
Connected, but the directory DATA_PUMP_DIR is not usable: writing failed (ORA-29283: invalid file operation)
```

**Solution:** The path of the directory object is missing on the server, or the `oracle` OS user cannot write it. Check it with `SELECT directory_path FROM all_directories WHERE directory_name = 'DATA_PUMP_DIR'` and create the folder. `ORA-29289` or `PLS-00201` means the login lacks `READ, WRITE` on the directory or `EXECUTE` on `UTL_FILE`.

### Thin mode cannot connect

```
NJS-138: connections to this database server version are not supported by node-oracledb in Thin mode
NJS-533: Advanced Networking Option service negotiation failed. Native Network Encryption and DataIntegrity only supported in node-oracledb thick mode.
```

**Solution:** The first means Oracle 11.2 or older. The second means the server requires Native Network Encryption. Use **TLS** instead, or **Over SSH**, or set `SQLNET.ENCRYPTION_SERVER` to `REQUESTED`. An account that only has the old 10G password verifier fails with `NJS-116`, change its password on a current server.

### Backing up another schema is refused

```
ORA-31631: privileges are required
```

**Solution:** Grant `DATAPUMP_EXP_FULL_DATABASE` to the login. Without it only its own schema can be backed up.

### The export runs out of undo

```
ORA-31693: Table data object "SHOP"."ORDERS" failed to load/unload and is being skipped due to error:
ORA-01555: snapshot too old
```

**Solution:** Increase `UNDO_RETENTION` or the undo tablespace, or turn **Consistent export** off for very large schemas.

### TLS through an SSH tunnel

```
TLS cannot be checked through an SSH tunnel.
```

**Solution:** Use one or the other. The certificate cannot be checked against `127.0.0.1`, and the SSH connection already encrypts the way to the server.

## Next Steps

- [Restore](/user-guide/features/restore) - Restore a schema, also under a new name
- [Encryption](/user-guide/security/encryption) - Encrypt the archives of your backups
- [Database Explorer](/user-guide/features/database-explorer) - Browse the tables of a schema
