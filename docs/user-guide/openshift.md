# OpenShift

DBackup runs on OpenShift with the image as it is, under the default `restricted-v2` security context constraint and without internet access.

## How the Image Starts There

OpenShift starts the container as an arbitrary user ID in group `0`, never as root. DBackup notices that at the start and runs every step as that user:

- `PUID` and `PGID` do not apply, since no user can be switched.
- `/data` has to be writable for that user. A PersistentVolumeClaim usually is, since OpenShift hands the volume to a group of the pod.
- The user gets an entry in `/etc/passwd` at the start, which `ssh` needs for the [rsync destination](/user-guide/destinations/rsync).

The same holds for `docker run --user` and for Kubernetes with `runAsUser`.

## Without Internet Access

A container needs no internet to start or to run. The image ships every tool and the Prisma schema engine, and switches off the usage data of the Prisma CLI and of SqlPackage, which would otherwise wait for their timeout at each start or each Azure SQL backup.

What is left reaches only what the cluster can reach:

- **Look for new versions** in the General part of [Settings](/user-guide/admin/settings) asks GitHub once a day and gives up after 5 seconds without holding up a page. Switch it off to stop the attempt.
- Sources, destinations, notifications and SSO need their own servers in reach, like an S3-compatible store or an SMTP server inside the network.

The build itself downloads the database tools, so build the image where it reaches the internet and copy it into a registry the cluster pulls from:

```bash
docker build -t registry.example.internal/dbackup/dbackup:latest .
docker push registry.example.internal/dbackup/dbackup:latest
```

Without a registry both sides reach, `docker save` the image to a file, carry it over and load it on the other side.

## Example

Create the two secrets once and keep them, see [Generate Secrets](/user-guide/installation#generate-secrets):

```bash
oc create secret generic dbackup \
  --from-literal=ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  --from-literal=BETTER_AUTH_SECRET="$(openssl rand -base64 32)"
```

Then apply the volume, the deployment, the service and the route, with your image and host:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: dbackup-data
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 5Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dbackup
spec:
  replicas: 1
  strategy:
    type: Recreate                       # One pod at a time on the SQLite database
  selector:
    matchLabels: { app: dbackup }
  template:
    metadata:
      labels: { app: dbackup }
    spec:
      terminationGracePeriodSeconds: 600 # Running backups finish before the pod stops
      containers:
        - name: dbackup
          image: registry.example.internal/dbackup/dbackup:latest
          ports:
            - containerPort: 3000
          envFrom:
            - secretRef: { name: dbackup }
          env:
            - { name: BETTER_AUTH_URL, value: "https://dbackup.apps.example.internal" }
            - { name: DISABLE_HTTPS, value: "true" }
            - { name: TZ, value: "Europe/Zurich" }
          volumeMounts:
            - { name: data, mountPath: /data }
            - { name: tmp, mountPath: /tmp }
          startupProbe:                  # Migrations run before the server listens
            httpGet: { path: /api/health, port: 3000 }
            periodSeconds: 5
            failureThreshold: 60
          readinessProbe:
            httpGet: { path: /api/health, port: 3000 }
            periodSeconds: 10
          livenessProbe:
            httpGet: { path: /api/health, port: 3000 }
            periodSeconds: 30
            failureThreshold: 3
      volumes:
        - name: data
          persistentVolumeClaim: { claimName: dbackup-data }
        - name: tmp                      # Staging space while a backup is built
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: dbackup
spec:
  selector: { app: dbackup }
  ports:
    - { port: 3000, targetPort: 3000 }
---
apiVersion: route.openshift.io/v1
kind: Route
metadata:
  name: dbackup
spec:
  host: dbackup.apps.example.internal
  to: { kind: Service, name: dbackup }
  port: { targetPort: 3000 }
  tls:
    termination: edge
    insecureEdgeTerminationPolicy: Redirect
```

The route terminates TLS, so DBackup serves plain HTTP with `DISABLE_HTTPS=true`, and `BETTER_AUTH_URL` is the `https://` address of the route, see [The Address and the Session Cookie](/user-guide/installation#the-address-and-the-session-cookie). In most clusters the router connects from a private address, which the default `TRUSTED_PROXIES` of `private` trusts. Otherwise add its addresses, see [The Address of a Client](/user-guide/installation#the-address-of-a-client).

::: tip Room for backups
Every backup is staged under `/tmp` before the upload, roughly twice the size of the source for file backups. Give the `emptyDir` a `sizeLimit` the node can hold, or mount a second claim there, see [Volume Mounts](/user-guide/installation#volume-mounts).
:::

## Troubleshooting

### The Pod Stops at the Start

```
Error: UID 1000680000 GID 0 cannot write to /data. Mount a volume there that this user can write, on OpenShift a PersistentVolumeClaim.
```

**Solution:** Mount a PersistentVolumeClaim at `/data`. A volume the cluster does not hand to the group of the pod, like some NFS exports, needs its owner or mode set on the server side.

### The Database Is Locked on NFS

**Solution:** Set `SQLITE_WAL_MODE=false`, or give `/data` a claim on block storage.

## Next Steps

- [Installation](/user-guide/installation) for every environment variable
- [First Steps](/user-guide/first-steps) once DBackup answers
