/**
 * Sauvegarde et restauration de tous les réglages (serveurs, dossiers favoris, préférences) dans
 * un fichier JSON — filet de sécurité avant une réinstallation de l'extension (ez-dl-vjr).
 */

import { useRef, useState, type ChangeEvent } from 'react';
import { exportSettings, importSettings } from '@/src/lib/settingsBackup';

type Status = { tone: 'success' | 'error'; message: string } | null;

function downloadText(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function BackupSection() {
  const [status, setStatus] = useState<Status>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function onExport(): Promise<void> {
    try {
      const date = new Date().toISOString().slice(0, 10);
      downloadText(await exportSettings(), `ez-dl-reglages-${date}.json`);
      setStatus({ tone: 'success', message: 'Réglages exportés.' });
    } catch {
      setStatus({ tone: 'error', message: "L'export a échoué." });
    }
  }

  async function onImport(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!window.confirm('Remplacer tous les réglages actuels par ceux du fichier ?')) return;
    try {
      const count = await importSettings(await file.text());
      setStatus({ tone: 'success', message: `Réglages restaurés (${count} serveur${count > 1 ? 's' : ''}).` });
    } catch (error) {
      setStatus({ tone: 'error', message: error instanceof Error ? error.message : "L'import a échoué." });
    }
  }

  return (
    <section className="options-section">
      <h2>Sauvegarde des réglages</h2>
      <p className="options-hint">
        Exportez vos réglages avant de supprimer ou de réinstaller l'extension : Chrome efface ses données avec
        elle. Le fichier contient tous les serveurs, dossiers favoris et préférences.
      </p>
      <p className="options-warning">Le fichier contient les mots de passe des serveurs en clair : gardez-le en lieu sûr.</p>
      <div>
        <button type="button" className="btn" onClick={() => void onExport()}>
          Exporter
        </button>{' '}
        <button type="button" className="btn btn-secondary" onClick={() => fileInput.current?.click()}>
          Importer…
        </button>
        <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={(event) => void onImport(event)} />
      </div>
      {status && (
        <p className={status.tone === 'success' ? 'field-success' : 'field-error'} role="status">
          {status.message}
        </p>
      )}
    </section>
  );
}
