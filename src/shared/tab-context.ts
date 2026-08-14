/**
 * Builds the location string sent to the classifier.
 *
 * The query and fragment are dropped unconditionally, opt-in or not: that is where session tokens,
 * search terms, and one-time links live. A path is structural by comparison, and it carries the
 * signal the hostname alone loses, such as a ticket key in `/browse/ATLAS-431`. Sending it stays
 * opt-in because a path can still name a private document.
 */
export function toClassificationHostname(url: string, includePath: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return '';
  }
  if (!includePath) {
    return parsed.hostname;
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.hostname}${path}`;
}
