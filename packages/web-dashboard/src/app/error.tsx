'use client';

import React from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div style={{
      padding: '2rem',
      textAlign: 'center',
      color: 'var(--text-secondary, #9ca3af)',
    }}>
      <h3 style={{ color: 'var(--text-primary, #e5e7eb)', marginBottom: '0.5rem' }}>
        Something went wrong
      </h3>
      <p style={{ fontSize: '0.875rem', marginBottom: '1rem', maxWidth: '400px', margin: '0 auto 1rem' }}>
        {error.message ?? 'An unexpected error occurred'}
      </p>
      <button
        onClick={reset}
        style={{
          padding: '0.5rem 1.25rem',
          borderRadius: '0.375rem',
          border: '1px solid var(--border-primary, #374151)',
          background: 'var(--surface-secondary, #1f2937)',
          color: 'var(--text-primary, #e5e7eb)',
          cursor: 'pointer',
          fontSize: '0.875rem',
        }}
      >
        Try again
      </button>
    </div>
  );
}
