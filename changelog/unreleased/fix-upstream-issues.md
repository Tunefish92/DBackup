### 🐛 Bug Fixes

- **MySQL**: Backups of MySQL 26 and later no longer fail with `SHOW PACKAGE STATUS`. DBackup reads their stored procedures and functions itself and writes them into the dump. ([#203](https://github.com/Skyfay/DBackup/issues/203))
- **Backups**: A backup that a later run wrote again under the same file name now shows the date and the details of that run. ([#201](https://github.com/Skyfay/DBackup/issues/201))
- **SSO**: A sign-in provider no longer asks for `offline_access`, so Google sign-in through Generic OIDC works. Existing providers are updated by a migration. ([#198](https://github.com/Skyfay/DBackup/issues/198))
- **SMB**: An upload to a folder the share refuses to create now fails with that folder and the reason from the server, and so does the connection test. ([#184](https://github.com/Skyfay/DBackup/issues/184))
- **SMB**: Listings no longer miss files and folders with long names, three or more attributes or lower-case attributes, which left whole folders or shares looking empty. ([#182](https://github.com/Skyfay/DBackup/issues/182))
- **Notifications**: The subject of a backup mail starts with the outcome again, like `Backup Failed: <job>`. ([#209](https://github.com/Skyfay/DBackup/issues/209))
- **Local Storage**: A directory source on a read-only mount no longer shows as offline, since its health check only asks for read access. ([#200](https://github.com/Skyfay/DBackup/issues/200))

### 🧪 Tests

- **lab**: The dev lab and the end-to-end tests run MySQL 26, and the MySQL dataset has a view that calls a stored function. A MySQL server of a new volume counts as healthy only once the server that stays is up.
