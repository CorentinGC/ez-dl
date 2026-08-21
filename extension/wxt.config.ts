import { defineConfig } from 'wxt';

// Voir https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'ez-dl',
    description:
      "Détecte les vidéos d'une page (HLS/DASH/MP4/WebM, ou via un extracteur yt-dlp) et les envoie à votre serveur ez-dl self-hosted pour téléchargement.",
    // Sniffing réseau (webRequest), état persistant (storage), onglet actif (tabs/activeTab),
    // cookies du site pour les pages authentifiées (cookies), picker DOM (scripting).
    permissions: ['webRequest', 'storage', 'tabs', 'activeTab', 'cookies', 'scripting'],
    // Nécessaire pour sniffer/probe n'importe quel site visité par l'utilisateur.
    host_permissions: ['<all_urls>'],
  },
});
