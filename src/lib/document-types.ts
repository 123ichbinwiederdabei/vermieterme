const imageAndPdfExtensions: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "message/rfc822": ".eml",
};
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export function originalExtension(mimeType: string, category: string): string | undefined {
  if (mimeType === DOCX_MIME) return ["contract", "lease", "stammdaten"].includes(category) ? ".docx" : undefined;
  return imageAndPdfExtensions[mimeType];
}
