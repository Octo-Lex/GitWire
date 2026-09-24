// Deterministic validation for model-generated issue-fix metadata.
// Generated commit text is untrusted input and must be canonical before any
// downstream GitHub write can consume it.

const MAX_GENERATED_COMMIT_MESSAGE_LENGTH = 120;
const MAX_GENERATED_EXPLANATION_LENGTH = 500;
const GENERATED_METADATA_CONTROL_RE = /[\u0000-\u001f\u007f\u2028\u2029]/;

export function validateGeneratedMetadata(path, fix, reasons) {
  if (fix.commit_message != null) {
    if (typeof fix.commit_message !== "string") {
      reasons.push(`${path}: commit_message must be a string`);
    } else {
      const trimmed = fix.commit_message.trim();
      if (!trimmed) reasons.push(`${path}: commit_message must not be empty`);
      if (fix.commit_message.length > MAX_GENERATED_COMMIT_MESSAGE_LENGTH) {
        reasons.push(`${path}: commit_message exceeds ${MAX_GENERATED_COMMIT_MESSAGE_LENGTH} characters`);
      }
      if (trimmed !== fix.commit_message) {
        reasons.push(`${path}: commit_message must not contain leading or trailing whitespace`);
      }
      if (GENERATED_METADATA_CONTROL_RE.test(fix.commit_message)) {
        reasons.push(`${path}: commit_message must be a single-line string without control characters`);
      }
    }
  }

  if (fix.explanation != null) {
    if (typeof fix.explanation !== "string") {
      reasons.push(`${path}: explanation must be a string`);
    } else {
      const trimmed = fix.explanation.trim();
      if (!trimmed) reasons.push(`${path}: explanation must not be empty`);
      if (fix.explanation.length > MAX_GENERATED_EXPLANATION_LENGTH) {
        reasons.push(`${path}: explanation exceeds ${MAX_GENERATED_EXPLANATION_LENGTH} characters`);
      }
      if (trimmed !== fix.explanation) {
        reasons.push(`${path}: explanation must not contain leading or trailing whitespace`);
      }
      if (GENERATED_METADATA_CONTROL_RE.test(fix.explanation)) {
        reasons.push(`${path}: explanation must be a single-line string without control characters`);
      }
    }
  }
}
