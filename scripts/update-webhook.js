import crypto from "crypto";
import fs from "fs";

const APP_ID = 3727207;
const key = fs.readFileSync(process.argv[2], "utf8");

const now = Math.floor(Date.now() / 1000);
const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 300, iss: APP_ID })).toString("base64url");
const sign = crypto.createSign("RSA-SHA256").update(`${header}.${payload}`).sign(key, "base64");
const sig = sign.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const jwt = `${header}.${payload}.${sig}`;

// Get app installations
const res = await fetch("https://api.github.com/app/installations", {
  headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json" },
});
const installations = await res.json();

if (!installations.length) {
  console.log("No installations yet. App needs to be installed on a repo first.");
  process.exit(0);
}

for (const inst of installations) {
  console.log(`Installation: ${inst.account.login} (${inst.id})`);
}

// Update webhook config
const webhookRes = await fetch(`https://api.github.com/app/hook/config`, {
  method: "PATCH",
  headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json" },
  body: JSON.stringify({
    content_type: "json",
    url: "https://gitwire.erlab.uk/webhooks/github",
    insecure_ssl: "0",
  }),
});

if (webhookRes.ok) {
  console.log("✅ Webhook URL updated to https://gitwire.erlab.uk/webhooks/github");
} else {
  const err = await webhookRes.json();
  console.log("❌ Failed:", JSON.stringify(err));
}
