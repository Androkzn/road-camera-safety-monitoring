/** Drop-in for the repeated `[foo, bar && "active"].filter(Boolean).join(" ")` pattern found at 41+ sites. */
export function cx(...args: Array<string | false | null | undefined>): string {
  return args.filter(Boolean).join(" ");
}
