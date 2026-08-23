/** Spreadsheet-style base-26 letter sequence: 0=A, 25=Z, 26=AA, 27=AB, ... */
export function letterSuffix(index: number): string {
  let n = index;
  let result = "";
  do {
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return result;
}

/** DDMMYYYY, e.g. 2026-08-12 -> "12082026". */
export function datePrefix(date: Date): string {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}${month}${year}`;
}
