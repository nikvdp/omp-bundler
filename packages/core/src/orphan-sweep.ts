import { sweepChildRegistry } from "./child-reaper.js";

const registryPath = process.env.OMP_CHILD_REGISTRY_PATH;
if (!registryPath) {
  throw new Error("OMP_CHILD_REGISTRY_PATH is required");
}

const result = await sweepChildRegistry(registryPath);
console.log(
  `>>> orphan sweep: reclaimed=${result.reclaimed.length} stale=${result.stale.length} denied=${result.denied.length}`,
);
if (result.denied.length > 0) {
  throw new Error(`orphan sweep could not reclaim ${result.denied.length} process group(s)`);
}
