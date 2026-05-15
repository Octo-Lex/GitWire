import crypto from 'crypto';
import fs from 'fs';

const APP_ID = 3727207;
const key = fs.readFileSync('gitwire-hq.2026-05-15.private-key.pem', 'utf8');
const now = Math.floor(Date.now() / 1000);
const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 300, iss: APP_ID })).toString('base64url');
const sig = crypto.createSign('RSA-SHA256').update(header + '.' + payload).sign(key, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = header + '.' + payload + '.' + sig;

// Get installation token
const instRes = await fetch('https://api.github.com/app/installations', {
  headers: { Authorization: 'Bearer ' + jwt, Accept: 'application/vnd.github+json' },
});
const installations = await instRes.json();
const instId = installations[0].id;

const tokenRes = await fetch('https://api.github.com/app/installations/' + instId + '/access_tokens', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + jwt, Accept: 'application/vnd.github+json' },
});
const { token } = await tokenRes.json();

// Create test issues
const issues = [
  {
    title: 'App crashes on startup when config file is missing',
    body: '## Bug Report\n\nWhen the config file is missing, the application crashes with an unhandled exception instead of showing a helpful error message.\n\n### Steps to reproduce\n1. Delete config.yaml\n2. Run `app start`\n3. Observe crash with `TypeError: Cannot read properties of undefined`\n\n### Expected behavior\nShow a clear error: "Config file not found. Run `app init` to create one."\n\n### Environment\n- OS: Ubuntu 22.04\n- Version: 1.2.3'
  },
  {
    title: 'Add dark mode support',
    body: '## Feature Request\n\nIt would be great to have a dark mode option for the dashboard. Currently the UI is only available in light theme.\n\n### Proposed solution\n- Add a theme toggle in the settings panel\n- Respect the system preference (`prefers-color-scheme`)\n- Store the preference in localStorage'
  },
  {
    title: 'How do I configure the API endpoint?',
    body: '## Question\n\nI\'m trying to connect to a custom API endpoint but the documentation doesn\'t explain how to set it up.\n\nIs there an environment variable or config option for changing the default API URL from `https://api.example.com` to my self-hosted instance?'
  },
];

for (const issue of issues) {
  const res = await fetch('https://api.github.com/repos/xjeddah/MyShell/issues', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' },
    body: JSON.stringify(issue),
  });
  const data = await res.json();
  console.log(res.status === 201 ? '✅ Created #' + data.number + ': ' + data.title : '❌ ' + res.status + ': ' + data.message);
}
