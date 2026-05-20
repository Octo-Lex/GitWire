// tests/stress/helpers.js
// Shared utilities for stress tests — handles rate limiting gracefully

import { BASE_URL, API_KEY } from '../helpers.js';

/**
 * Sleep for ms milliseconds
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch with automatic retry on 429 rate limit
 */
export async function resilientGet(path, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
    });
    if (res.status === 429 && attempt < retries) {
      const retryAfter = parseInt(res.headers.get('Retry-After') || '1', 10) * 1000;
      await sleep(Math.min(retryAfter, 2000));
      continue;
    }
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
  }
}

/**
 * Run tasks with rate-limit awareness: max N concurrent, with optional delay between batches
 */
export async function boundedBurst(tasks, options = {}) {
  const { maxConcurrent = 8, delayBetweenBatches = 500 } = options;
  const start = Date.now();
  const results = [];

  for (let i = 0; i < tasks.length; i += maxConcurrent) {
    const batch = tasks.slice(i, i + maxConcurrent);
    const batchResults = await Promise.allSettled(batch.map(fn => fn()));
    results.push(...batchResults);
    if (i + maxConcurrent < tasks.length && delayBetweenBatches > 0) {
      await sleep(delayBetweenBatches);
    }
  }

  const elapsed = Date.now() - start;
  const succeeded = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;
  const statuses = results.map(r =>
    r.status === 'fulfilled' ? r.value?.status : 0
  );
  return { elapsed, succeeded, failed, total: tasks.length, statuses, results };
}
