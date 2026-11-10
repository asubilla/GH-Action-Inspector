import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/log/redact.js";

// Clearly synthetic credential-shaped strings built at runtime so no scanner
// mistakes them for real credentials.
const FAKE_GH = `ghp_${"A".repeat(36)}`;
const FAKE_FINE_GRAINED = `github_pat_${"B".repeat(30)}`;
const FAKE_SLACK = `xoxb-${"1".repeat(12)}-${"C".repeat(12)}`;
// Split so repository secret scanners do not flag AWS's public documentation key.
const FAKE_AWS = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const FAKE_JWT = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "c2lnbmF0dXJl"].join(".");
// Built dynamically so repository secret scanners do not flag this synthetic,
// non-functional example while the redaction test still exercises the pattern.
const PRIVATE_KEY_LABEL = ["PRIVATE", "KEY"].join(" ");
const FAKE_PRIVATE_KEY = [
  `-----BEGIN RSA ${PRIVATE_KEY_LABEL}-----`,
  "MIIEowIBAAKCAQEAfakefakefakefakefakefakefakefake",
  `-----END RSA ${PRIVATE_KEY_LABEL}-----`,
].join("\n");

describe("secret redaction", () => {
  it("redacts GitHub token formats", () => {
    const result = redactSecrets(`token=${FAKE_GH} and ${FAKE_FINE_GRAINED}`);
    expect(result.text).not.toContain(FAKE_GH);
    expect(result.text).not.toContain(FAKE_FINE_GRAINED);
    expect(result.text).toContain("[REDACTED");
    expect(result.redactionCount).toBeGreaterThanOrEqual(2);
  });

  it("redacts other common token formats", () => {
    const result = redactSecrets(
      `slack=${FAKE_SLACK} aws=${FAKE_AWS} jwt=${FAKE_JWT} stripe=sk_live_${"z".repeat(24)}`,
    );
    expect(result.text).not.toContain(FAKE_SLACK);
    expect(result.text).not.toContain(FAKE_AWS);
    expect(result.text).not.toContain(FAKE_JWT);
    expect(result.text).not.toContain("sk_live_");
  });

  it("redacts entire private key blocks", () => {
    const result = redactSecrets(`before\n${FAKE_PRIVATE_KEY}\nafter`);
    expect(result.text).not.toContain("MIIEowIBAAKCAQEA");
    expect(result.text).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(result.text).toContain("before");
    expect(result.text).toContain("after");
  });

  it("redacts unterminated and PGP private key blocks conservatively", () => {
    const unterminated = `error before\n-----BEGIN ${PRIVATE_KEY_LABEL}-----\nMIIEsecretlookingbody\nno end marker`;
    const result = redactSecrets(unterminated);
    expect(result.text).not.toContain("MIIEsecretlookingbody");
    expect(result.text).toContain("error before");
    expect(result.text).toContain("[REDACTED:private-key-block]");

    const pgpHeader = ["-----BEGIN PGP", `PRIVATE KEY ${["BLOCK"].join("")}-----`].join(" ");
    const pgp = `${pgpHeader}\npgpbody\n-----END PGP ${PRIVATE_KEY_LABEL} BLOCK-----`;
    expect(redactSecrets(pgp).text).not.toContain("pgpbody");
  });

  it("redacts authorization headers and bearer tokens", () => {
    const result = redactSecrets("Authorization: Bearer abcdefghijklmnop\nBearer zyxwvutsrqponmlk");
    expect(result.text).not.toContain("abcdefghijklmnop");
    expect(result.text).not.toContain("zyxwvutsrqponmlk");
  });

  it("redacts secret-like assignments while preserving key names", () => {
    const result = redactSecrets(
      [
        "GITHUB_TOKEN=abc123456",
        "export API_KEY='super-secret-value'",
        "DB_PASSWORD: hunter2hunter2",
        "private_key: not-a-real-key-value",
      ].join("\n"),
    );
    expect(result.text).toContain("GITHUB_TOKEN=");
    expect(result.text).toContain("API_KEY=");
    expect(result.text).not.toContain("abc123456");
    expect(result.text).not.toContain("super-secret-value");
    expect(result.text).not.toContain("hunter2hunter2");
    expect(result.text).not.toContain("not-a-real-key-value");
  });

  it("redacts JSON secret properties", () => {
    const result = redactSecrets(
      '{"password":"hunter2","nested":{"client_secret":"s3cr3t-value"},"safe":"visible"}',
    );
    expect(result.text).not.toContain("hunter2");
    expect(result.text).not.toContain("s3cr3t-value");
    expect(result.text).toContain('"safe":"visible"');
  });

  it("redacts URL userinfo and sensitive query parameters", () => {
    const result = redactSecrets(
      "https://user:password@example.com/callback?access_token=abc123&ref=main",
    );
    expect(result.text).not.toContain("password");
    expect(result.text).not.toContain("abc123");
    expect(result.text).toContain("ref=main");
  });

  it("applies additive custom patterns and cannot disable built-ins", () => {
    const result = redactSecrets(`acme-12345 ${FAKE_GH}`, {
      extraPatterns: [/acme-[0-9]+/g],
    });
    expect(result.text).not.toContain("acme-12345");
    expect(result.text).not.toContain(FAKE_GH);
    expect(result.categories).toContain("custom-pattern");
    expect(result.categories).toContain("github-token");
  });

  it("leaves ordinary text untouched", () => {
    const text = "Test suite failed: expected 2 to be 3 in src/sum.test.ts:12";
    const result = redactSecrets(text);
    expect(result.text).toBe(text);
    expect(result.redactionCount).toBe(0);
  });

  it("counts GitHub-masked placeholders without inventing values", () => {
    const result = redactSecrets("token was *** and ***");
    expect(result.maskedPlaceholderCount).toBe(2);
    expect(result.text).toBe("token was *** and ***");
  });

  it("is defensive about empty input and repeated runs", () => {
    expect(redactSecrets("")).toEqual({
      text: "",
      redactionCount: 0,
      categories: [],
      maskedPlaceholderCount: 0,
    });
    const once = redactSecrets(`TOKEN=${FAKE_GH}`).text;
    const twice = redactSecrets(once).text;
    expect(twice).not.toContain(FAKE_GH);
  });
});
