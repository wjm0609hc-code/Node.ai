// Nod's logo: a geometric lowercase "nod" drawn as strokes, with the "o" a solid
// dot that dips below the line, like a head mid-nod. Paths only (no font), so it
// renders the same everywhere: the site, the favicon and the contact photo.

const N = `<path d="M10 27V50M10 38a10.5 10.5 0 0 1 21 0V50" fill="none" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>`;
const O = `<circle cx="51" cy="45" r="9.5" stroke="none"/>`;
const D = `<circle cx="80" cy="38.5" r="11.5" fill="none" stroke-width="7"/><path d="M91.5 12V50" fill="none" stroke-width="7" stroke-linecap="round"/>`;

/** The wordmark (102×64 units), drawn in `currentColor` unless a colour is given. */
export function nodWordmarkSvg(opts: { height?: number; color?: string; title?: string } = {}): string {
  const c = opts.color ?? "currentColor";
  const h = opts.height ?? 32;
  const w = Math.round((h * 102) / 64);
  const label = opts.title ? ` role="img" aria-label="${opts.title}"` : ` aria-hidden="true"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 102 64" width="${w}" height="${h}"${label}><g fill="${c}" stroke="${c}">${N}${O}${D}</g></svg>`;
}

/** Square favicon: just the dipped dot between two strokes would be illegible, so it's the wordmark, centred. */
export function nodFaviconSvg(color = "#1c1c1e"): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -19 102 102"><g fill="${color}" stroke="${color}">${N}${O}${D}</g></svg>`;
}

/** Square app icon / contact photo: the wordmark in white on near-black, small enough to survive a round crop. */
export function nodIconSvg(size = 512): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160" width="${size}" height="${size}"><rect width="160" height="160" fill="#1c1c1e"/><g transform="translate(29 44)" fill="#fff" stroke="#fff">${N}${O}${D}</g></svg>`;
}
