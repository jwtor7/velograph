import type { InsightPayload } from './payload.ts';
import type { DestinationKind } from './types.ts';

/**
 * Bump whenever the privacy policy or disclosure text changes; the app
 * re-prompts pre-send disclosure (AI-004) whenever a stored acknowledgement
 * doesn't match this version.
 */
export const POLICY_VERSION = 'ai-privacy-policy-v1';

const DESTINATION_LABEL: Record<DestinationKind, string> = {
  none: 'None — AI is disabled; nothing leaves this machine.',
  'local-loopback': 'Local loopback only — stays on this machine (Ollama).',
  remote: 'Remote provider — the payload below would leave this machine (Codex/OpenAI).',
};

const NOT_SENT_NOTE =
  'Not sent, ever: route coordinates, raw time-series samples, source file names or paths, ' +
  'device/source strings, route names, local notes.';

/**
 * Renders a human-readable preview of exactly what would be sent, for
 * pre-send disclosure (AI-004). Pure function — text in, text out.
 */
export function renderPayloadPreview(
  payload: InsightPayload,
  destination: DestinationKind,
): string {
  const lines: string[] = [];
  lines.push(
    `Velograph AI insight payload preview (${payload.payloadVersion}, policy ${POLICY_VERSION})`,
  );
  lines.push(`Destination: ${DESTINATION_LABEL[destination]}`);
  lines.push('');
  lines.push('Metrics included:');
  for (const m of payload.metrics) {
    lines.push(`  - ${m.id}: ${m.value === null ? 'unavailable' : m.value} ${m.unit}`);
  }
  if (payload.zones && payload.zones.length > 0) {
    lines.push('');
    lines.push('Heart-rate zone time shares:');
    for (const z of payload.zones) {
      lines.push(`  - ${z.label}: ${(z.shareOfTime * 100).toFixed(1)}%`);
    }
  }
  lines.push('');
  lines.push('Personal context included (only when explicitly supplied):');
  for (const [field, state] of Object.entries(payload.context)) {
    lines.push(`  - ${field}: ${state}`);
  }
  lines.push('');
  lines.push(NOT_SENT_NOTE);
  return lines.join('\n');
}
