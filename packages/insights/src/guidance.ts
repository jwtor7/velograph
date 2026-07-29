/**
 * Non-clinical guidance (AI-011). Insight narratives are informational
 * training commentary, never medical advice — this disclaimer must ship
 * with every generated output, and diagnostic phrasing is rejected outright.
 */
export const NON_CLINICAL_DISCLAIMER =
  'Velograph AI insights are informational training commentary generated from your own ride ' +
  'data. They are not medical advice and must not be used to diagnose, treat, or manage a ' +
  'health condition. Consult a qualified professional for medical guidance.';

const DIAGNOSTIC_PHRASE_PATTERNS: readonly RegExp[] = [
  /\bdiagnos(e|is|ed|ing|es)\b/i,
  /\byou (have|may have|likely have) (a|an) [a-z][a-z -]* (disease|disorder|condition|syndrome)\b/i,
  /\bprescri(be|bed|bing|ption)\b/i,
  /\bmedical (condition|diagnosis)\b/i,
  /\byou (should|need to) (take|stop taking) [a-z][a-z -]*(medication|medicine|drug)\b/i,
];

/** True when text uses diagnostic/prescriptive phrasing that AI-011 forbids. */
export function containsDiagnosticPhrasing(text: string): boolean {
  return DIAGNOSTIC_PHRASE_PATTERNS.some((pattern) => pattern.test(text));
}
