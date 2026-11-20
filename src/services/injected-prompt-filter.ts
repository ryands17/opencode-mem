const DEFAULT_INJECTION_MARKERS: readonly string[] = [
  "<system-reminder>",
  "<!-- OMO_INTERNAL_INITIATOR -->",
  "<!-- OMO_INTERNAL_NOREPLY -->",
  "[SYSTEM DIRECTIVE: OH-MY-OPENCODE",
  "[Agent Usage Reminder]",
  "[Category+Skill Reminder]",
  "<team_mode_status",
  "<auto-slash-command>",
];

export function getDefaultInjectionMarkers(): readonly string[] {
  return DEFAULT_INJECTION_MARKERS;
}

/**
 * Returns true when `text` contains any configured injection marker.
 *
 * Matching is case-insensitive so that host variations in tag casing (for
 * example `<System-Reminder>`) are still recognised.
 */
export function containsInjectionMarker(
  text: string,
  markers: readonly string[] = DEFAULT_INJECTION_MARKERS
): boolean {
  if (!text) return false;
  const haystack = text.toLowerCase();
  for (const marker of markers) {
    if (!marker) continue;
    if (haystack.includes(marker.toLowerCase())) return true;
  }
  return false;
}

/** Minimal shape this module needs from an OpenCode message part. */
export interface InjectionFilterablePart {
  readonly type?: string;
  readonly text?: string;
  readonly synthetic?: boolean;
}

/**
 * Returns true when a part was injected rather than typed by the user.
 *
 * A part counts as injected when it is flagged `synthetic` by the host, or when
 * its text carries a known injection marker.
 */
export function isInjectedPart(
  part: InjectionFilterablePart,
  markers: readonly string[] = DEFAULT_INJECTION_MARKERS
): boolean {
  if (part.synthetic === true) return true;
  return containsInjectionMarker(part.text ?? "", markers);
}

/**
 * Drops injected parts and returns the user-authored text parts.
 *
 * When every part is injected the result is empty, signalling the caller to skip
 * recording the message entirely.
 */
export function filterInjectedParts<T extends InjectionFilterablePart>(
  parts: readonly T[],
  markers: readonly string[] = DEFAULT_INJECTION_MARKERS
): T[] {
  return parts.filter((part) => !isInjectedPart(part, markers));
}
