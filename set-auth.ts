// Usage: pbpaste | bun set-auth.ts
//    or: bun set-auth.ts < curl.txt

const input = await Bun.stdin.text();

function extract(label: string, pattern: RegExp): string {
  const m = input.match(pattern);
  if (!m) throw new Error(`Could not find ${label}`);
  return m[1];
}

const bearer = extract(
  "Authorization",
  /authorization:\s*Bearer\s+([^\s'"\\]+)/i
);

const authToken = extract(
  "auth_token cookie",
  /auth_token=([^;'"\\]+)/
);

const csrfToken = extract(
  "x-csrf-token",
  /x-csrf-token:\s*([^\s'"\\]+)/i
);

const env = [
  `X_BEARER_TOKEN="${bearer}"`,
  `X_AUTH_TOKEN="${authToken}"`,
  `X_CSRF_TOKEN="${csrfToken}"`,
].join("\n") + "\n";

await Bun.write(".env", env);

console.log("✓ .env written");
console.log(`  bearer:     ${bearer.slice(0, 20)}...`);
console.log(`  auth_token: ${authToken.slice(0, 10)}...`);
console.log(`  csrf_token: ${csrfToken.slice(0, 10)}...`);
