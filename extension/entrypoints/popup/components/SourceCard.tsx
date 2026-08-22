/**
 * Fiche d'une source détectée : bouton « Télécharger » en un clic avec des valeurs par défaut
 * sensées (meilleure qualité, dossier favori par défaut, preset par défaut), et un panneau
 * repliable pour affiner qualité/nom de fichier/dossier/preset/cookies avant l'envoi.
 */

import { useCallback, useId, useMemo, useState } from 'react';
import type { ApiClient } from '@/src/lib/api';
import { sanitizeFilename } from '@/src/lib/filename';
import {
  defaultFilenameForMedia,
  defaultFilenameForProbe,
  resolveDefaultFolder,
  sortFormatsBestFirst,
} from '@/src/lib/quickSource';
import type { ExtensionSettings, MediaKind, Preset } from '@/src/lib/types';
import { FolderPicker } from './FolderPicker';
import { readCookiesForUrl } from '@/src/lib/cookies';
import type { Source } from '../types';

interface SourceCardProps {
  source: Source;
  apiClient: ApiClient;
  settings: ExtensionSettings;
  presets: Preset[];
  pageUrl: string;
  pageTitle: string;
  onDownloaded: () => void;
}

type SubmitState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'error'; message: string }
  /** Le serveur connaît déjà cette vidéo : on avertit, le clic suivant force le téléchargement. */
  | { status: 'duplicate'; message: string }
  | { status: 'success' };

export function SourceCard({ source, apiClient, settings, presets, pageUrl, pageTitle, onDownloaded }: SourceCardProps) {
  const idBase = useId();
  const isProbe = source.kind === 'probe';
  const formats = useMemo(() => (isProbe ? sortFormatsBestFirst(source.formats) : []), [isProbe, source]);
  const defaultFormatId = isProbe ? (source.bestFormatId ?? formats[0]?.format_id ?? null) : null;

  const [formatId, setFormatId] = useState<string | null>(defaultFormatId);
  // Flux sniffé : URL effectivement téléchargée, modifiable via le choix de qualité.
  const [sniffedUrl, setSniffedUrl] = useState<string | null>(isProbe ? null : source.mediaUrl);
  const [filename, setFilename] = useState(() => computeDefaultFilename(source, pageTitle, defaultFormatId));
  const [folder, setFolder] = useState<{ path: string; label: string } | null>(resolveDefaultFolder(settings));
  const [presetId, setPresetId] = useState<string>(settings.defaultPresetId ?? presets[0]?.id ?? 'copy');
  const [sendCookies, setSendCookies] = useState(settings.sendCookies);
  const [expanded, setExpanded] = useState(false);
  const [submit, setSubmit] = useState<SubmitState>({ status: 'idle' });

  const handleDownload = useCallback(
    async (isForced: boolean) => {
      if (!folder) {
        setSubmit({ status: 'error', message: 'Choisissez un dossier de destination.' });
        setExpanded(true);
        return;
      }
      const url = source.kind === 'probe' ? source.pageUrl : (sniffedUrl ?? source.mediaUrl);
      const safeFilename = sanitizeFilename(filename);
      setSubmit({ status: 'submitting' });
      try {
        if (!isForced) {
          const duplicate = await lookupDuplicate(apiClient, url, folder.path, safeFilename);
          if (duplicate) {
            setSubmit({ status: 'duplicate', message: duplicate });
            return;
          }
        }
        const cookies = sendCookies ? await readCookiesForUrl(pageUrl) : undefined;
        await apiClient.createJob({
          url,
          format_id: source.kind === 'probe' && formatId ? formatId : undefined,
          folder: folder.path,
          filename: safeFilename,
          preset_id: presetId,
          cookies,
          referer: pageUrl,
          title: source.title,
        });
        setSubmit({ status: 'success' });
        onDownloaded();
      } catch (err) {
        setSubmit({ status: 'error', message: err instanceof Error ? err.message : 'Erreur inconnue.' });
      }
    },
    [apiClient, filename, folder, formatId, onDownloaded, pageUrl, presetId, sendCookies, sniffedUrl, source],
  );

  const isDuplicate = submit.status === 'duplicate';

  const thumbnail = source.kind === 'probe' ? source.thumbnail : null;

  return (
    <article className="source-card">
      <div className="source-card-main">
        {thumbnail ? (
          <img className="source-card-thumb" src={thumbnail} alt="" />
        ) : (
          <div className="source-card-thumb source-card-thumb-placeholder" aria-hidden="true">
            {kindLabel(source)}
          </div>
        )}
        <div className="source-card-info">
          <p className="source-card-title" title={source.title}>
            {source.title}
          </p>
          <p className="source-card-kind">{kindLabel(source)}</p>
        </div>
      </div>

      <div className="source-card-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={submit.status === 'submitting'}
          onClick={() => void handleDownload(isDuplicate)}
        >
          {submit.status === 'submitting' ? 'Envoi…' : isDuplicate ? 'Retélécharger' : 'Télécharger'}
        </button>
        <button type="button" className="btn btn-ghost" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Masquer les options' : 'Options avancées'}
        </button>
      </div>

      {submit.status === 'error' ? (
        <p className="field-error" role="alert">
          {submit.message}
        </p>
      ) : null}
      {isDuplicate ? (
        <p className="field-warning" role="alert">
          {submit.message}
        </p>
      ) : null}
      {submit.status === 'success' ? (
        <p className="field-success" role="status">
          Job créé, voir l'onglet « Jobs ».
        </p>
      ) : null}

      {expanded ? (
        <div className="source-card-advanced">
          {source.kind === 'probe' ? (
            <div className="field">
              <label className="field-label" htmlFor={`format-${idBase}`}>
                Qualité
              </label>
              <select
                id={`format-${idBase}`}
                className="field-select"
                value={formatId ?? ''}
                onChange={(event) => setFormatId(event.target.value)}
              >
                {formats.map((format) => (
                  <option key={format.format_id} value={format.format_id}>
                    {format.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {source.kind === 'sniffed' && (source.qualityVariants?.length ?? 0) > 1 ? (
            <div className="field">
              <label className="field-label" htmlFor={`quality-${idBase}`}>
                Qualité
              </label>
              <select
                id={`quality-${idBase}`}
                className="field-select"
                value={sniffedUrl ?? source.mediaUrl}
                onChange={(event) => setSniffedUrl(event.target.value)}
              >
                {source.qualityVariants?.map((variant) => (
                  <option key={variant.url} value={variant.url}>
                    {variant.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="field">
            <label className="field-label" htmlFor={`filename-${idBase}`}>
              Nom de fichier
            </label>
            <input
              id={`filename-${idBase}`}
              className="field-input"
              type="text"
              value={filename}
              onChange={(event) => setFilename(event.target.value)}
            />
          </div>

          <FolderPicker
            apiClient={apiClient}
            favorites={settings.favoriteFolders}
            value={folder?.path ?? null}
            onChange={(path, label) => setFolder({ path, label })}
            fieldId={`folder-${idBase}`}
          />

          <div className="field">
            <label className="field-label" htmlFor={`preset-${idBase}`}>
              Conversion
            </label>
            <select id={`preset-${idBase}`} className="field-select" value={presetId} onChange={(event) => setPresetId(event.target.value)}>
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </select>
          </div>

          {settings.sendCookies ? (
            <label className="field-checkbox">
              <input type="checkbox" checked={sendCookies} onChange={(event) => setSendCookies(event.target.checked)} />
              Envoyer les cookies du site
            </label>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

/**
 * Message d'avertissement si le serveur a déjà téléchargé cette vidéo, `null` sinon. Une erreur
 * (serveur d'une version antérieure, route absente) n'empêche jamais le téléchargement.
 */
async function lookupDuplicate(
  apiClient: ApiClient,
  url: string,
  folder: string,
  filename: string,
): Promise<string | null> {
  try {
    const existing = await apiClient.lookupExistingJob({ url, folder, filename });
    if (!existing.found) return null;
    const name = existing.job?.filename ?? filename;
    return existing.reason === 'file'
      ? `Le fichier « ${name} » existe déjà dans ce dossier. Relancer créera une copie.`
      : `Déjà téléchargée (« ${name} »). Relancer créera une copie.`;
  } catch {
    return null;
  }
}

/** Défauts délégués à `quickSource` : la popup et le bouton en overlay doivent proposer le
 * même nom de fichier pour une même source. */
function computeDefaultFilename(source: Source, pageTitle: string, formatId: string | null): string {
  if (source.kind === 'probe') {
    return defaultFilenameForProbe(
      { title: source.title, suggested_filename: source.suggestedFilename, formats: source.formats },
      pageTitle,
      formatId,
    );
  }
  return defaultFilenameForMedia(source.mediaKind, source.title, pageTitle);
}

function kindLabel(source: Source): string {
  if (source.kind === 'probe') return 'yt-dlp';
  const labels: Record<MediaKind, string> = { hls: 'HLS', dash: 'DASH', mp4: 'MP4', webm: 'WebM', 'other-video': 'Vidéo' };
  return labels[source.mediaKind];
}
