// src/lib/imageRetentionPolicy.js
// Protected image-retention selection policy (#425 incident follow-up,
// second disk-exhaustion incident; authorized design + implementation).
//
// Docker's "unused image" is NOT GitWire's "disposable image": the pinned
// validator dependency (ghcr.io/octo-lex/gitwire-validator@sha256:…) is
// never referenced by a running container, yet the deploy REQUIRES it to
// resolve locally — an unrestricted `docker image prune -a` deleted it on
// 2026-11-21 and blocked the release deployment. This module computes the
// SAFE removal set:
//
//   KEEP — any image whose repo@digest EXACTLY equals a protected
//   reference (digest-qualified refs from the production config AND the
//   authoritative current/rollback release records; ANY registry). Exact
//   match only — a shared repository or tag confers no protection;
//   KEEP — any image EXACTLY referenced by a running container (by image
//   id or by its repo:tag reference) — never by bare repository name,
//   which would retain every image of a running repo and defeat the
//   accumulation cure;
//   KEEP — the N most recent images per MANAGED repository (rollback
//   candidates; N defaults to 3: current + two previous releases);
//   KEEP — every image under a repository GitWire does NOT manage (the
//   managed-repository allowlist comes from the protected records —
//   unrelated services and stopped-container images are outside GitWire's
//   ownership and are never eligible for cleanup);
//   REMOVE — the remainder of managed repositories only. The mandatory
//   subset (production pins + the current release record) additionally
//   gates the whole decision: any unresolved mandatory ref marks the
//   evidence unsafe and is reported, never silently swallowed.
//
// Pure function: the caller gathers the inputs (docker CLI or fixtures in
// tests) and executes the removal. The executor script
// (scripts/prune-protected-images.sh) refuses to run without at least one
// protected ref, so an empty pin list can never degrade into an
// unrestricted prune.

/**
 * @typedef {Object} ImageRecord
 * @property {string} repository  image repository (e.g. ghcr.io/octo-lex/gitwire-app)
 * @property {string} [tag]       image tag (e.g. latest, sha-abc123)
 * @property {string} [digest]    repo digest without the repo@ prefix (sha256:…)
 * @property {string} id          image id
 * @property {string} created     sortable creation timestamp (ISO or epoch)
 *
 * @param {Object} input
 * @param {ImageRecord[]} input.images              full local image inventory
 * @param {string[]}      input.protectedRefs       digest-qualified refs that must survive (config + release records)
 * @param {string[]}      [input.mandatoryRefs]     subset that MUST resolve locally; any miss is fatal evidence
 * @param {string[]}      [input.managedRepositories] repositories GitWire owns; ONLY these are eligible for removal
 * @param {string[]}      input.runningImages       image ids/exact repo:tag refs used by running containers
 * @param {number}        [input.keepPerRepo=3]     rollback candidates retained per managed repository
 * @returns {{ keep: ImageRecord[], remove: ImageRecord[], keptProtected: string[], keptRollback: number, keptUnmanaged: number, mandatoryResolved: boolean, unresolvedMandatory: string[] }}
 */
export function selectImagesToRemove({ images, protectedRefs, mandatoryRefs = [], managedRepositories = null, runningImages, keepPerRepo = 3 }) {
  const protectedSet = new Set(
    (protectedRefs || []).filter((r) => r.includes("@sha256:")),
  );
  const mandatorySet = new Set(
    (mandatoryRefs || []).filter((r) => r.includes("@sha256:")),
  );
  const managedSet = managedRepositories === null
    ? null // null = unrestricted legacy behavior (tests default); the
           // executor always passes the allowlist.
    : new Set(managedRepositories);
  const runningSet = new Set(runningImages || []);

  const keep = new Set(); // by id
  const keptProtected = [];

  // 1. Explicitly protected refs (digest-qualified).
  for (const img of images) {
    if (!img.digest) continue;
    const ref = `${img.repository}@${img.digest}`;
    if (protectedSet.has(ref)) {
      keep.add(img.id);
      keptProtected.push(ref);
    }
  }

  // 2. Referenced by a running container: exact matches only (image id,
  //    the full repo:tag the container runs, or the repo@digest reference
  //    docker reports for digest-run containers). A bare repository match
  //    would protect every digest under a running repo — the retention
  //    failure mode this policy exists to prevent.
  for (const img of images) {
    const runningTagRef = img.tag ? `${img.repository}:${img.tag}` : null;
    const runningDigestRef = img.digest ? `${img.repository}@${img.digest}` : null;
    if (runningSet.has(img.id)
      || (runningTagRef && runningSet.has(runningTagRef))
      || (runningDigestRef && runningSet.has(runningDigestRef))) {
      keep.add(img.id);
    }
  }

  // 3. Rollback candidates: the N most recent per repository name.
  const byRepo = new Map();
  for (const img of images) {
    if (!byRepo.has(img.repository)) byRepo.set(img.repository, []);
    byRepo.get(img.repository).push(img);
  }
  let keptRollback = 0;
  for (const [repo, list] of byRepo) {
    list.sort((a, b) => String(b.created).localeCompare(String(a.created)));
    for (const img of list.slice(0, keepPerRepo)) {
      if (keep.has(img.id)) continue;
      keep.add(img.id);
      keptRollback += 1;
    }
    void repo;
  }

  // Ownership allowlist: images under repositories GitWire does not manage
  // are NEVER removable, regardless of age or running state.
  let keptUnmanaged = 0;
  const keepArr = [];
  const remove = [];
  for (const img of images) {
    if (keep.has(img.id)) { keepArr.push(img); continue; }
    if (managedSet !== null && !managedSet.has(img.repository)) {
      keepArr.push(img); // outside GitWire's ownership — preserve unconditionally
      keptUnmanaged += 1;
      continue;
    }
    remove.push(img);
  }

  // Mandatory resolution gate: production pins + the current release
  // record must all be present locally; any miss is fatal evidence.
  const presentRefs = new Set(
    images.filter((i) => i.digest).map((i) => `${i.repository}@${i.digest}`),
  );
  const unresolvedMandatory = [...mandatorySet].filter((r) => !presentRefs.has(r));
  return {
    keep: keepArr,
    remove,
    keptProtected,
    keptRollback,
    keptUnmanaged,
    mandatoryResolved: unresolvedMandatory.length === 0,
    unresolvedMandatory,
  };
}
