/**
 * What is eating the disk that ISN'T The Lab's data volume.
 *
 * The Storage manager measures `DATA_DIR` — but `statfs` reports the whole
 * host filesystem, so the "used" figure includes everything else on the box.
 * On this deployment that gap is the larger number by far: Docker image layers
 * and BuildKit's build cache live under /var/lib/{docker,containerd}, which the
 * server (a container) cannot walk. Without this module the manager can only
 * say "193 GB used, 14 GB accounted for" and leave the operator guessing.
 *
 * Docker's own Engine API can answer for its share. The socket is already
 * mounted (see docker-compose.yml — it exists so the suite can restart Postiz),
 * so we ask `GET /system/df` and report:
 *
 *   images      → total layer bytes, and how much belongs to images no
 *                 container uses (dangling ones are safe to prune)
 *   buildCache  → BuildKit cache, and the unshared part that prunes cleanly
 *   containers  → writable container layers
 *   otherVolumes→ Docker volumes other than the one we just measured
 *
 * CAVEAT, stated in the UI too: Docker's own accounting overlaps. A build-cache
 * record marked `Shared` is the same bytes as an image layer, so image size +
 * build-cache size double-counts by that amount and the parts do NOT sum to the
 * filesystem total. The reclaimable figures are the honest, actionable ones —
 * they are what a prune would actually give back — so those are what we lead
 * with, and `unattributed` (below) absorbs the rest rather than pretending.
 *
 * Pruning is limited to the two operations that cannot lose work: BuildKit
 * cache (rebuilt on the next build) and DANGLING images (untagged leftovers).
 * Tagged-but-unused images are reported and never touched — on this box they
 * are deliberate `backup-pre-*` / `candidate-*` rollback tags.
 */
import http from "node:http";

const DOCKER_SOCKET = process.env.DOCKER_SOCKET || "/var/run/docker.sock";

/** The subset of `GET /system/df` we actually read. */
interface DockerDf {
  LayersSize?: number;
  Images?: Array<{ Size?: number; Containers?: number; RepoTags?: string[] | null }>;
  Containers?: Array<{ SizeRw?: number }>;
  Volumes?: Array<{ UsageData?: { Size?: number } | null }>;
  BuildCache?: Array<{ Size?: number; InUse?: boolean; Shared?: boolean }>;
}

/** One line item in the "outside The Lab" breakdown. */
export interface SystemBucket {
  key: string;
  label: string;
  hint: string;
  icon: string;
  size: number;
  count: number;
  /** Bytes a prune would actually return. 0 when nothing here is prunable. */
  reclaimable: number;
  /** Prune target accepted by pruneSystemStorage, when this bucket is prunable. */
  prune?: "buildCache" | "danglingImages";
}

export interface SystemUsage {
  available: boolean;
  /** Why the Docker breakdown is missing (socket absent / denied / timed out). */
  reason?: string;
  buckets: SystemBucket[];
}

/** Docker Engine API call over the unix socket. Rejects with a clean message. */
function dockerRequest<T>(method: string, pathName: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const req = http.request(
      { socketPath: DOCKER_SOCKET, method, path: pathName, timeout: 30_000 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`Docker API ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body || "{}") as T);
          } catch (e) {
            reject(new Error(`Docker API returned non-JSON: ${(e as Error).message}`));
          }
        });
      },
    );
    // `docker system df` walks every layer; on a large store it is slow, hence 30s.
    req.on("timeout", () => req.destroy(new Error("Docker socket request timed out")));
    req.on("error", reject);
    req.end();
  });
}

/**
 * Ask Docker what it is holding. `dataDirBytes` is the size we just measured for
 * DATA_DIR, used to subtract our own volume out of Docker's volume total so the
 * "other volumes" line doesn't re-count the bytes already itemised as app data.
 * Never throws — a missing/denied socket returns `available:false` with a reason.
 */
export async function readSystemUsage(dataDirBytes: number): Promise<SystemUsage> {
  let df: DockerDf;
  try {
    df = await dockerRequest<DockerDf>("GET", "/system/df");
  } catch (e) {
    const msg = (e as NodeJS.ErrnoException)?.code === "ENOENT"
      ? "The Docker socket isn't mounted into this container, so the rest of the disk can't be itemised here."
      : `Couldn't read Docker's disk usage: ${(e as Error).message}`;
    return { available: false, reason: msg, buckets: [] };
  }

  const images = df.Images ?? [];
  const buildCache = df.BuildCache ?? [];
  const containers = df.Containers ?? [];
  const volumes = df.Volumes ?? [];

  // An image is reclaimable only if NO container uses it AND it has no tag —
  // an untagged, unused image is a leftover of a rebuild. Tagged-but-unused
  // images are somebody's rollback point and are counted separately.
  const unused = images.filter((i) => !i.Containers);
  const dangling = unused.filter((i) => !(i.RepoTags ?? []).filter((t) => t !== "<none>:<none>").length);
  const danglingBytes = dangling.reduce((s, i) => s + (i.Size ?? 0), 0);
  const taggedUnused = unused.length - dangling.length;

  // `Shared` cache records are the same bytes as an image layer — pruning them
  // frees nothing, so only the unshared, not-in-use part counts as reclaimable.
  const cacheBytes = buildCache.reduce((s, b) => s + (b.Size ?? 0), 0);
  const cacheReclaimable = buildCache
    .filter((b) => !b.InUse && !b.Shared)
    .reduce((s, b) => s + (b.Size ?? 0), 0);

  const volumeBytes = volumes.reduce((s, v) => s + (v.UsageData?.Size ?? 0), 0);
  const containerBytes = containers.reduce((s, c) => s + (c.SizeRw ?? 0), 0);

  const buckets: SystemBucket[] = [
    {
      key: "dockerImages",
      label: "Docker image layers",
      hint: taggedUnused > 0
        ? `Every built image on the box. ${taggedUnused} tagged image${taggedUnused !== 1 ? "s are" : " is"} unused — those are deliberate rollback tags (backup-pre-*, candidate-*), so they're never pruned from here; remove one on the server with "docker image rm <tag>".`
        : "Every built image on the box. Untagged leftovers from rebuilds are safe to prune.",
      icon: "Layers",
      size: df.LayersSize ?? 0,
      count: images.length,
      reclaimable: danglingBytes,
      prune: danglingBytes > 0 ? "danglingImages" : undefined,
    },
    {
      key: "dockerBuildCache",
      label: "Docker build cache",
      hint: "BuildKit's cache of every build step ever run here. Pure cache — a prune only makes the next build slower, never breaks anything. This is usually the biggest thing on a box that builds often.",
      icon: "Hammer",
      size: cacheBytes,
      count: buildCache.length,
      reclaimable: cacheReclaimable,
      prune: cacheReclaimable > 0 ? "buildCache" : undefined,
    },
    {
      key: "otherVolumes",
      label: "Other Docker volumes",
      hint: "Data volumes belonging to the other services in the stack (Postiz, its Postgres/Redis, the WhatsApp sidecar). The Lab's own volume is excluded — it's itemised above.",
      icon: "Boxes",
      size: Math.max(0, volumeBytes - dataDirBytes),
      count: Math.max(0, volumes.length - 1),
      reclaimable: 0,
    },
    {
      key: "containerLayers",
      label: "Container writable layers",
      hint: "Files written inside running containers, outside any volume. Reset when a container is recreated.",
      icon: "Container",
      size: containerBytes,
      count: containers.length,
      reclaimable: 0,
    },
  ];

  return { available: true, buckets: buckets.filter((b) => b.size > 0 || b.reclaimable > 0) };
}

/**
 * Run one of the two safe prunes. Returns bytes actually reclaimed as reported
 * by Docker. Anything else (including `all=true` variants that would delete
 * tagged images or in-use cache) is rejected.
 */
export async function pruneSystemStorage(input: any): Promise<{ freed: number; errors: string[] }> {
  const target = input?.target;
  // `all=false`/dangling-only: neither can remove an image a container uses, and
  // neither can remove build cache that is still referenced.
  const ENDPOINTS: Record<string, string> = {
    buildCache: "/build/prune",
    danglingImages: `/images/prune?filters=${encodeURIComponent(JSON.stringify({ dangling: ["true"] }))}`,
  };
  const endpoint = ENDPOINTS[target];
  if (!endpoint) {
    return { freed: 0, errors: [`Not a prunable target: ${target}`] };
  }
  try {
    const res = await dockerRequest<{ SpaceReclaimed?: number }>("POST", endpoint);
    return { freed: res.SpaceReclaimed ?? 0, errors: [] };
  } catch (e) {
    return { freed: 0, errors: [`Prune failed: ${(e as Error).message}`] };
  }
}
