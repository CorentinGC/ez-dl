/**
 * Les messages privilégiés (règles, état d'onglet, picker) ne doivent venir que des pages de
 * l'extension. Un content script s'exécute dans une page web : son `sender.url` est celui de la
 * page, jamais `chrome-extension://<id>/…`.
 */

export function isExtensionSender(senderUrl: string | undefined, extensionBaseUrl: string): boolean {
  if (!senderUrl || !extensionBaseUrl) return false;
  return senderUrl.startsWith(extensionBaseUrl);
}
