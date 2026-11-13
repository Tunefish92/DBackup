### ✨ Features

- **docker**: The image runs on OpenShift under the arbitrary user ID of `restricted-v2`, and anywhere else that starts it as a user other than root.

### 🎨 Improvements

- **docker**: The Prisma CLI and SqlPackage in the image send no usage data, so a host without internet no longer waits for their timeout.

### 📝 Documentation

- **installation**: New guide for OpenShift without internet access, with an example of every resource DBackup needs there.

### 🧪 Tests

- **docker**: A lint guard keeps the image able to start as a user other than root and without internet.
