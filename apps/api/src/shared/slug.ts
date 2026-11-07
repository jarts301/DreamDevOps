/**
 * Short, fixed identifiers made from names, used to name resources such as Git
 * organizations and repositories. They keep only lowercase letters, digits and single
 * hyphens, so they suit most tools' naming rules.
 */
export function slugFromName(name: string, options: { maxLength: number; prefix: string }): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, options.maxLength)
    .replace(/^-+|-+$/g, '');
  return slug.length >= 2 ? slug : `${options.prefix}-${slug}`.replace(/-+$/, '') || options.prefix;
}

/** Adds a numbered suffix when the slug is taken, keeping it within the length limit. */
export function numberedSlug(slug: string, number: number, maxLength: number): string {
  const suffix = `-${number}`;
  return `${slug.slice(0, maxLength - suffix.length).replace(/-+$/, '')}${suffix}`;
}
