/**
 * Preset de conversion par défaut, choisi parmi la liste `GET /api/capabilities` (dépend des
 * encodeurs disponibles sur le serveur).
 */

import type { ExtensionSettings, Preset } from '@/src/lib/types';

interface PresetSectionProps {
  settings: ExtensionSettings;
  presets: Preset[];
  presetsLoading: boolean;
  onUpdate: (patch: Partial<ExtensionSettings>) => Promise<ExtensionSettings>;
}

export function PresetSection({ settings, presets, presetsLoading, onUpdate }: PresetSectionProps) {
  return (
    <section className="options-section">
      <h2>Preset de conversion par défaut</h2>
      <p className="options-section-description">
        Appliqué par défaut lors du téléchargement en un clic (modifiable au cas par cas dans les options avancées
        de la popup). « copy » (remux sans réencodage) est toujours disponible.
      </p>
      {presetsLoading ? <p className="options-hint">Chargement des presets…</p> : null}
      {!presetsLoading && presets.length === 0 ? (
        <p className="options-hint">Configurez le serveur pour lister ses presets disponibles.</p>
      ) : null}
      {presets.length > 0 ? (
        <div className="field">
          <label className="field-label" htmlFor="default-preset">
            Preset
          </label>
          <select
            id="default-preset"
            className="field-select"
            value={settings.defaultPresetId ?? presets[0]?.id ?? 'copy'}
            onChange={(event) => void onUpdate({ defaultPresetId: event.target.value })}
          >
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id} title={preset.description}>
                {preset.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
    </section>
  );
}
