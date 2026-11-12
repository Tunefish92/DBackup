### 🔒 Security

- **deps**: Next.js 16.4.3 closes a denial of service through Server Actions, and Zod 4.6.7 and nodemailer 10.3.1 close a memory exhaustion in validation and three recipient parsing flaws. `sharp`, `undici`, `qs`, `fast-uri`, `ip-address`, `minimatch`, `fast-xml-parser` and the API reference page move to patched releases, in the app and on the website.
- **deps**: Prisma 7 replaces the configuration loading of Prisma 6 and its vulnerable `deepmerge-ts`.

### 🎨 Improvements

- **Docker**: The image ships MongoDB Database Tools 100.20.0 and the Firebird 5.0.4 client tools.
- **deps**: The pending minor releases are picked up across the app, the website, the docs and the sponsors images, among them React 19.3.1, Radix UI, the AWS SDK, croner 11, googleapis 188, the iconify icon sets 2, TypeScript 6 and Vitest 5. `tar-stream` and `webdav` stay where they are, since their next releases change their types.
- **deps**: DBackup runs on Prisma 7, better-auth 1.7 and TanStack Table 9. A migration adds a column that the SSO plugin of better-auth checks for.

### 🧪 Tests

- **e2e**: The restore of a tenant's database no longer fails when the check reads the table while the restore recreates it.

### 🔧 CI/CD

- **ci**: Every workflow uses the current major version of its actions, which run on Node 24.
