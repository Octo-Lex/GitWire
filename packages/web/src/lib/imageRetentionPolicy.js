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
//   KEEP — any image whose repo@digest is an explicitly protected
//   reference (deploy pins: validator, app, executor, dashboard, plus any
//   ref ending in a digest listed as protected);
//   KEEP — any image referenced by a running container;
//   KEEP — the N most recent images per repository name (rollback
//   candidates; N defaults to 3: current + two previous releases);
//   REMOVE — everything else.
//
// Pure function: the caller gathers the inputs (docker CLI or fixtures in
// tests) and executes the removal. The executor script
// (scripts/prune-protected-images.sh) refuses to run without at least one
// protected ref, so an empty pin list can never degrade into an
// unrestricted prune.

/**
 * @typedef {Object} ImageRecord
 * @property {string} repository  image repository (e.g. ghcr.io/octo-lex/gitwire-app)
 * @property {string} [digest]    repo digest without the repo@ prefix (sha256:…)
 * @property {string} id          image id
 * @property {string} created     sortable creation timestamp (ISO or epoch)
 *
 * @param {Object} input
 * @param {ImageRecord[]} input.images            full local image inventory
 * @param {string[]}      input.protectedRefs     digest-qualified refs that must survive (deploy pins)
 * @param {string[]}      input.runningImages     image ids/repo:tag refs used by running containers
 * @param {number}        [input.keepPerRepo=3]   rollback candidates retained per repository
 * @returns {{ keep: ImageRecord[], remove: ImageRecord[], keptProtected: string[], keptRollback: number }}
 */
export function selectImagesToRemove({ images, protectedRefs, runningImages, keepPerRepo = 3 }) {
  const protectedSet = new Set(
    (protectedRefs || []).filter((r) => r.includes("@sha256:")),
  );
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

  // 2. Referenced by a running container (by id or by repository match).
  for (const img of images) {
    if (runningSet.has(img.id) || runningSet.has(img.repository)) {
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

  const keepArr = images.filter((i) => keep.has(i.id));
  const remove = images.filter((i) => !keep.has(i.id));
  return { keep: keepArr, remove, keptProtected, keptRollback };
}
