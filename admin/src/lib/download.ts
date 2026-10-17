/** Saves a file from the browser: an export, or a certificate as it was added. */
export function saveFile(name: string, file: Blob): void {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
